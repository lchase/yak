import pLimit from 'p-limit'
import { z } from 'zod'
import { buildProducerMap, dependenciesOf } from '../ir/graph.js'
import type { ArtifactName, Step, StepId, Workflow } from '../ir/types.js'
import { CommandResultSchema, CommandStepFailedError, runCommandStep } from '../steps/command.js'
import { runTransformStep } from '../steps/transform.js'
import { readArtifactRaw, writeArtifact } from './artifacts.js'
import {
  computeDefinitionKey,
  computeSemanticKey,
  decideCache,
  readCacheEntry,
  writeCacheEntry,
} from './cache.js'
import { appendJournalEvent } from './journal.js'
import type { ReplayedStep } from './journal.js'

const DEFAULT_CONCURRENCY = 4

export interface ScheduleContext {
  runId: string
  runDir: string
  cwd: string
  cacheDir: string
  concurrency?: number
}

function collectInputHashes(
  step: Step,
  artifactHashes: Map<ArtifactName, string>,
): Record<ArtifactName, string> {
  const inputArtifactHashes: Record<ArtifactName, string> = {}
  for (const need of step.needs ?? []) {
    const hash = artifactHashes.get(need)
    if (hash) inputArtifactHashes[need] = hash
  }
  return inputArtifactHashes
}

/**
 * Spec §4.4 `yak resume`: for each step the journal already marked complete,
 * recompute its cache keys against the current step definition and the
 * (possibly just-reused) input artifact hashes. A match trusts the artifact
 * already on disk in `runDir/artifacts` and skips re-running the step; a
 * mismatch leaves it (and so, transitively, everything downstream) out of
 * `completed`, so the normal scheduler loop re-runs it.
 *
 * Walks to a fixpoint since trusting an upstream step can unlock trusting
 * the one after it, in whatever order `remaining` iterates.
 */
function trustResumedSteps(
  remaining: Map<StepId, Step>,
  producerOf: Map<ArtifactName, StepId>,
  resumeState: Map<StepId, ReplayedStep>,
  completed: Set<StepId>,
  artifactHashes: Map<ArtifactName, string>,
): void {
  let progressed = true
  while (progressed) {
    progressed = false
    for (const step of remaining.values()) {
      const info = resumeState.get(step.id)
      if (!info) continue
      if (!dependenciesOf(step, producerOf).every((dep) => completed.has(dep))) continue

      const semanticKey = computeSemanticKey(step, collectInputHashes(step, artifactHashes))
      const definitionKey = computeDefinitionKey(step)
      if (semanticKey !== info.semanticKey || definitionKey !== info.definitionKey) continue

      completed.add(step.id)
      remaining.delete(step.id)
      if (info.artifact && info.artifactHash) artifactHashes.set(info.artifact, info.artifactHash)
      progressed = true
    }
  }
}

/**
 * Spec §4.3: any step whose `needs` are all satisfied is eligible; run
 * eligible steps up to a concurrency cap, and re-evaluate eligibility on
 * every completion (not just once a whole batch drains) so a step can start
 * the moment its dependencies are met.
 *
 * `resumeState` (spec §13 engine loop: "replay journal -> completed set")
 * seeds already-completed steps from a prior, interrupted run of the same
 * workflow — see `trustResumedSteps`.
 */
export async function runEligibleSteps(
  workflow: Workflow,
  ctx: ScheduleContext,
  resumeState?: Map<StepId, ReplayedStep>,
): Promise<'ok' | 'failed'> {
  const limit = pLimit(ctx.concurrency ?? DEFAULT_CONCURRENCY)
  const producerOf = buildProducerMap(workflow.steps)
  const remaining = new Map(workflow.steps.map((s) => [s.id, s]))
  const completed = new Set<StepId>()
  const inFlight = new Map<StepId, Promise<'ok' | 'failed'>>()
  const artifactHashes = new Map<ArtifactName, string>()
  let failed = false

  if (resumeState) trustResumedSteps(remaining, producerOf, resumeState, completed, artifactHashes)

  function launchEligible(): void {
    if (failed) return
    for (const step of remaining.values()) {
      if (inFlight.has(step.id)) continue
      if (dependenciesOf(step, producerOf).every((dep) => completed.has(dep))) {
        inFlight.set(step.id, limit(() => runStep(step, ctx, artifactHashes)))
      }
    }
  }

  launchEligible()

  while (inFlight.size > 0) {
    const [doneId, status] = await Promise.race(
      [...inFlight.entries()].map(async ([id, p]) => [id, await p] as const),
    )
    inFlight.delete(doneId)
    remaining.delete(doneId)
    if (status === 'failed') failed = true
    else completed.add(doneId)
    launchEligible()
  }

  if (!failed && remaining.size > 0) {
    const stuck = [...remaining.keys()].join(', ')
    throw new Error(`workflow stalled: step(s) [${stuck}] never became eligible`)
  }

  return failed ? 'failed' : 'ok'
}

async function runStep(
  step: Step,
  ctx: ScheduleContext,
  artifactHashes: Map<ArtifactName, string>,
): Promise<'ok' | 'failed'> {
  if (step.kind !== 'command' && step.kind !== 'transform') {
    throw new Error(`step "${step.id}": kind "${step.kind}" not yet supported in M0`)
  }

  const semanticKey = computeSemanticKey(step, collectInputHashes(step, artifactHashes))
  const definitionKey = computeDefinitionKey(step)

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey,
    definitionKey,
  })

  const cacheMode = step.cache ?? 'strict'
  const existingEntry = await readCacheEntry(ctx.cacheDir, semanticKey)
  const decision = decideCache(cacheMode, definitionKey, existingEntry)

  if (decision.kind === 'hit') {
    const { entry } = decision
    let artifactHash: string | undefined
    if (entry.artifactName) {
      const artifactSchema = step.kind === 'command' ? CommandResultSchema : z.unknown()
      const written = await writeArtifact(ctx.runDir, entry.artifactName, entry.artifact, artifactSchema)
      artifactHash = written.hash
      artifactHashes.set(entry.artifactName, artifactHash)
    }
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.completed',
      stepId: step.id,
      ...(entry.artifactName ? { artifact: entry.artifactName, artifactHash } : {}),
      cached: true,
      ...(decision.stale ? { stale: true } : {}),
    })
    return 'ok'
  }

  let result: unknown
  try {
    if (step.kind === 'command') {
      result = runCommandStep(step, ctx.cwd)
    } else {
      const inputs: Record<string, unknown> = {}
      for (const need of step.needs ?? []) {
        inputs[need] = await readArtifactRaw(ctx.runDir, need)
      }
      result = await runTransformStep(step, inputs, ctx.cwd)
    }
  } catch (err) {
    if (err instanceof CommandStepFailedError) {
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'step.failed',
        stepId: step.id,
        failure: err.failure,
      })
      return 'failed'
    }
    throw err
  }

  let artifactName: ArtifactName | undefined
  let artifactHash: string | undefined
  if (step.produces) {
    const artifact =
      step.kind === 'command'
        ? await writeArtifact(ctx.runDir, step.produces, result, CommandResultSchema)
        : await writeArtifact(ctx.runDir, step.produces, result, z.unknown())
    artifactName = artifact.name
    artifactHash = artifact.hash
    artifactHashes.set(artifact.name, artifact.hash)
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'artifact.written',
      name: artifact.name,
      hash: artifact.hash,
      bytes: artifact.bytes,
    })
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.completed',
    stepId: step.id,
    ...(artifactName ? { artifact: artifactName, artifactHash } : {}),
    cached: false,
  })

  await writeCacheEntry(ctx.cacheDir, {
    semanticKey,
    definitionKey,
    ...(artifactName ? { artifactName, artifactHash, artifact: result } : {}),
  })

  return 'ok'
}
