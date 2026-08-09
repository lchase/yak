import pLimit from 'p-limit'
import { z } from 'zod'
import { buildProducerMap, dependenciesOf } from '../ir/graph.js'
import type { Step, StepId, Workflow } from '../ir/types.js'
import { sha256 } from '../util/hash.js'
import { CommandResultSchema, CommandStepFailedError, runCommandStep } from '../steps/command.js'
import { runTransformStep } from '../steps/transform.js'
import { readArtifactRaw, writeArtifact } from './artifacts.js'
import { appendJournalEvent } from './journal.js'

const DEFAULT_CONCURRENCY = 4

export interface ScheduleContext {
  runId: string
  runDir: string
  cwd: string
  concurrency?: number
}

/**
 * Spec §4.3: any step whose `needs` are all satisfied is eligible; run
 * eligible steps up to a concurrency cap, and re-evaluate eligibility on
 * every completion (not just once a whole batch drains) so a step can start
 * the moment its dependencies are met.
 */
export async function runEligibleSteps(
  workflow: Workflow,
  ctx: ScheduleContext,
): Promise<'ok' | 'failed'> {
  const limit = pLimit(ctx.concurrency ?? DEFAULT_CONCURRENCY)
  const producerOf = buildProducerMap(workflow.steps)
  const remaining = new Map(workflow.steps.map((s) => [s.id, s]))
  const completed = new Set<StepId>()
  const inFlight = new Map<StepId, Promise<'ok' | 'failed'>>()
  let failed = false

  function launchEligible(): void {
    if (failed) return
    for (const step of remaining.values()) {
      if (inFlight.has(step.id)) continue
      if (dependenciesOf(step, producerOf).every((dep) => completed.has(dep))) {
        inFlight.set(step.id, limit(() => runStep(step, ctx)))
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

async function runStep(step: Step, ctx: ScheduleContext): Promise<'ok' | 'failed'> {
  if (step.kind !== 'command' && step.kind !== 'transform') {
    throw new Error(`step "${step.id}": kind "${step.kind}" not yet supported in M0`)
  }

  const definitionKey = sha256(JSON.stringify(step))
  const semanticKey =
    step.kind === 'command'
      ? sha256(`${step.id}:${step.run}`)
      : sha256(`${step.id}:${step.fn}`)

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey,
    definitionKey,
  })

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

  if (step.produces) {
    const artifact =
      step.kind === 'command'
        ? await writeArtifact(ctx.runDir, step.produces, result, CommandResultSchema)
        : await writeArtifact(ctx.runDir, step.produces, result, z.unknown())
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'artifact.written',
      name: artifact.name,
      hash: artifact.hash,
      bytes: artifact.bytes,
    })
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.completed',
      stepId: step.id,
      artifact: artifact.name,
      artifactHash: artifact.hash,
      cached: false,
    })
  } else {
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.completed',
      stepId: step.id,
      cached: false,
    })
  }

  return 'ok'
}
