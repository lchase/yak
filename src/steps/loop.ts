import { z } from 'zod'
import type { AgentAdapter } from '../adapters/types.js'
import { readArtifactRaw, writeArtifact } from '../engine/artifacts.js'
import {
  computeDefinitionKey,
  computeSemanticKey,
  decideCache,
  readCacheEntry,
  writeCacheEntry,
} from '../engine/cache.js'
import { appendJournalEvent, readJournal } from '../engine/journal.js'
import { evalExpr } from '../expr/eval.js'
import { buildProducerMap, inputNamesOf } from '../ir/graph.js'
import type { ArtifactName, LoopStep, Step, StepId } from '../ir/types.js'
import { AgentStepFailedError, runAgentStep } from './agent.js'
import { CommandResultSchema, CommandStepFailedError, runCommandStep } from './command.js'
import { runTransformStep } from './transform.js'

export interface LoopRunContext {
  runId: string
  runDir: string
  cwd: string
  cacheDir: string
  /** The loop step's own semantic/definition key — computed by the
   * scheduler the same way as any other step, so `step.started`/
   * `step.completed` on the loop id itself carry the same fields every
   * other step kind's do. */
  semanticKey: string
  definitionKey: string
  /** Hashes of artifacts produced outside this loop, already on disk under
   * their flat (non-iteration) path — an external need's contribution to a
   * body step's cache key. */
  outerArtifactHashes: Map<ArtifactName, string>
  buildAdapter: (stepId: StepId, iteration: number) => AgentAdapter
}

/** Ticket 01/02/03/04/10: runs a `loop` step to completion — success
 * (`until` satisfied), budget exhaustion (`onExhausted`), or a body step's
 * hard failure. Body steps execute strictly in declared order each
 * iteration (never fanned out or reordered) — spec's `loop` bounds
 * iteration, it isn't a scheduler of its own.
 *
 * Ticket 09: brackets the loop id itself with the same `step.started`/
 * `step.completed`-or-`step.failed` shape every other step kind gets, so
 * status tooling has something to key off besides the per-iteration
 * body-step and `run.suspended` events. A `'suspended'` outcome
 * deliberately leaves no `step.completed`/`step.failed` — the dangling
 * `step.started` reads as "pending", the same convention as any other step
 * interrupted mid-flight. */
export async function runLoopStep(step: LoopStep, ctx: LoopRunContext): Promise<'ok' | 'failed' | 'suspended'> {
  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey: ctx.semanticKey,
    definitionKey: ctx.definitionKey,
  })

  const status = await runLoopBody(step, ctx)

  // `'failed'` already got its own, more specific `step.failed` journaled
  // at the point of failure (body-step hard failure or onExhausted: 'fail')
  // — this wrapper only needs to cover the success case.
  if (status === 'ok') {
    await appendJournalEvent(ctx.runDir, ctx.runId, { t: 'step.completed', stepId: step.id, cached: false })
  }

  return status
}

async function runLoopBody(step: LoopStep, ctx: LoopRunContext): Promise<'ok' | 'failed' | 'suspended'> {
  const localProducerOf = buildProducerMap(step.body)
  const bodyOrderIndex = new Map(step.body.map((s, i) => [s.id, i]))
  const bodyStepIds = new Set(step.body.map((s) => s.id))

  let priorValues = new Map<ArtifactName, unknown>()
  let priorHashes = new Map<ArtifactName, string>()
  let lastSignal: unknown

  for (let iteration = 1; ; iteration++) {
    const thisValues = new Map<ArtifactName, unknown>()
    const thisHashes = new Map<ArtifactName, string>()

    try {
      for (const [posIndex, bodyStep] of step.body.entries()) {
        await runOneBodyStep({
          bodyStep,
          posIndex,
          iteration,
          ctx,
          localProducerOf,
          bodyOrderIndex,
          priorValues,
          priorHashes,
          thisValues,
          thisHashes,
        })
      }
    } catch (err) {
      if (err instanceof CommandStepFailedError || err instanceof AgentStepFailedError) {
        // the body step's own step.failed was already journaled in
        // runBodyStepKind — this covers the loop step id itself.
        await appendJournalEvent(ctx.runDir, ctx.runId, {
          t: 'step.failed',
          stepId: step.id,
          failure: {
            reason: err.failure.reason,
            detail: `loop "${step.id}" body step failed: ${err.failure.detail}`,
            recoverable: false,
          },
        })
        return 'failed'
      }
      throw err
    }

    const untilContext = Object.fromEntries(thisValues)
    if (await evalExpr(step.until, untilContext, ctx.cwd)) return 'ok'

    let tripped: 'maxIterations' | 'maxTokens' | 'noProgress' | undefined
    if (step.budget.noProgress) {
      lastSignal = await evalExpr(step.budget.noProgress.signal, untilContext, ctx.cwd)
    }

    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'loop.iteration',
      stepId: step.id,
      n: iteration,
      ...(lastSignal !== undefined ? { signal: lastSignal } : {}),
    })

    if (step.budget.noProgress) {
      tripped = (await noProgressTripped(step, ctx, iteration)) ? 'noProgress' : tripped
    }
    if (!tripped && iteration >= step.budget.maxIterations) tripped = 'maxIterations'
    if (!tripped && step.budget.maxTokens !== undefined) {
      const tokensTotal = await sumBodyTokens(ctx.runDir, bodyStepIds)
      if (tokensTotal >= step.budget.maxTokens) tripped = 'maxTokens'
    }

    if (tripped) return await handleExhausted(step, ctx, iteration, tripped)

    priorValues = thisValues
    priorHashes = thisHashes
  }
}

/** Ticket 02: noProgress is a non-decreasing (not strict-equality) signal —
 * `rounds` consecutive iterations where the signal never improved (never
 * decreased) trips it. Recomputed from the journal's `loop.iteration`
 * events each check, so it's resume-consistent with ticket 03's budget
 * accounting rather than tracked only in this function's local state. */
async function noProgressTripped(step: LoopStep, ctx: LoopRunContext, iteration: number): Promise<boolean> {
  const rounds = step.budget.noProgress!.rounds
  const events = await readJournal(ctx.runDir)
  const signals = events
    .filter((e) => e.t === 'loop.iteration' && e.stepId === step.id && e.n <= iteration)
    .map((e) => (e as { signal?: unknown }).signal)
    .filter((s): s is number => typeof s === 'number')

  if (signals.length < rounds) return false
  const recent = signals.slice(-rounds)
  for (let i = 1; i < recent.length; i++) {
    if (recent[i]! < recent[i - 1]!) return false // an improvement anywhere in the window resets it
  }
  return true
}

/** Ticket 03: running totals are summed from `budget.consumed` journal
 * events scoped to this loop instance's body step ids — no separate
 * counter, resume-correct for free. */
async function sumBodyTokens(runDir: string, bodyStepIds: Set<StepId>): Promise<number> {
  const events = await readJournal(runDir)
  return events
    .filter((e) => e.t === 'budget.consumed' && bodyStepIds.has(e.stepId))
    .reduce((sum, e) => sum + (e as { tokens: number }).tokens, 0)
}

/** Ticket 04: `onExhausted` policy. `'suspend'` journals `run.suspended`
 * (journal-only stub, no gate-shaped pending file — there is no answer to
 * ever write back to it) and returns `'suspended'`, which the scheduler
 * propagates to `EX_SUSPEND` (exit 78). `'fail'` journals `step.failed` on
 * the loop step itself. `'continue'` treats exhaustion as acceptable. */
async function handleExhausted(
  step: LoopStep,
  ctx: LoopRunContext,
  iteration: number,
  tripped: 'maxIterations' | 'maxTokens' | 'noProgress',
): Promise<'ok' | 'failed' | 'suspended'> {
  const onExhausted = step.onExhausted ?? 'suspend'

  if (onExhausted === 'continue') return 'ok'

  if (onExhausted === 'fail') {
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'step.failed',
      stepId: step.id,
      failure: {
        reason: 'budget-exhausted',
        detail: `loop "${step.id}" exhausted (${tripped}) after ${iteration} iterations`,
        recoverable: false,
      },
    })
    return 'failed'
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'run.suspended',
    reason: 'exhausted',
    loopStepId: step.id,
    iteration,
    tripped,
  })
  return 'suspended'
}

interface RunOneBodyStepArgs {
  bodyStep: Step
  posIndex: number
  iteration: number
  ctx: LoopRunContext
  localProducerOf: Map<ArtifactName, StepId>
  bodyOrderIndex: Map<StepId, number>
  priorValues: Map<ArtifactName, unknown>
  priorHashes: Map<ArtifactName, string>
  thisValues: Map<ArtifactName, unknown>
  thisHashes: Map<ArtifactName, string>
}

/** Ticket 01's within-iteration ordering: a need resolved via the loop-local
 * producer map takes *this* iteration's value if its producer already ran
 * this round (earlier body position); otherwise the *prior* iteration's
 * value (`undefined` on iteration 1). A need resolved via the outer scope
 * is external and already on disk before the loop started. */
async function runOneBodyStep(args: RunOneBodyStepArgs): Promise<void> {
  const {
    bodyStep,
    posIndex,
    iteration,
    ctx,
    localProducerOf,
    bodyOrderIndex,
    priorValues,
    priorHashes,
    thisValues,
    thisHashes,
  } = args

  const inputs: Record<string, unknown> = {}
  const inputHashesForKey: Record<string, string> = {}

  for (const name of inputNamesOf(bodyStep)) {
    const producerId = localProducerOf.get(name)
    if (producerId !== undefined) {
      const producerPos = bodyOrderIndex.get(producerId)!
      const fromThisRound = producerPos < posIndex
      inputs[name] = fromThisRound ? thisValues.get(name) : priorValues.get(name)
      const hash = fromThisRound ? thisHashes.get(name) : priorHashes.get(name)
      if (hash) inputHashesForKey[name] = hash
    } else {
      inputs[name] = await readArtifactRaw(ctx.runDir, name)
      const hash = ctx.outerArtifactHashes.get(name)
      if (hash) inputHashesForKey[name] = hash
    }
  }

  const semanticKey = computeSemanticKey(bodyStep, inputHashesForKey, iteration)
  const definitionKey = computeDefinitionKey(bodyStep)

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: bodyStep.id,
    iteration,
    semanticKey,
    definitionKey,
  })

  const cacheMode = bodyStep.cache ?? 'strict'
  const existingEntry = await readCacheEntry(ctx.cacheDir, semanticKey)
  const decision = decideCache(cacheMode, definitionKey, existingEntry)

  let result: unknown
  let cached = false
  let stale = false

  if (decision.kind === 'hit') {
    result = decision.entry.artifact
    cached = true
    stale = decision.stale
  } else {
    result = await runBodyStepKind(bodyStep, inputs, ctx, iteration)
  }

  let artifactHash: string | undefined
  if (bodyStep.produces) {
    const schema = bodyStep.kind === 'command' ? CommandResultSchema : z.unknown()
    const written = await writeArtifact(ctx.runDir, bodyStep.produces, result, schema, iteration)
    artifactHash = written.hash
    thisValues.set(bodyStep.produces, result)
    thisHashes.set(bodyStep.produces, artifactHash)
    if (!cached) {
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'artifact.written',
        name: bodyStep.produces,
        hash: artifactHash,
        bytes: written.bytes,
      })
    }
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.completed',
    stepId: bodyStep.id,
    iteration,
    ...(bodyStep.produces ? { artifact: bodyStep.produces, artifactHash } : {}),
    cached,
    ...(stale ? { stale: true } : {}),
  })

  if (!cached) {
    await writeCacheEntry(ctx.cacheDir, {
      semanticKey,
      definitionKey,
      ...(bodyStep.produces ? { artifactName: bodyStep.produces, artifactHash, artifact: result } : {}),
    })
  }
}

async function runBodyStepKind(
  bodyStep: Step,
  inputs: Record<string, unknown>,
  ctx: LoopRunContext,
  iteration: number,
): Promise<unknown> {
  try {
    if (bodyStep.kind === 'command') return runCommandStep(bodyStep, ctx.cwd)
    if (bodyStep.kind === 'transform') return await runTransformStep(bodyStep, inputs, ctx.cwd)
    if (bodyStep.kind === 'agent') {
      const adapter = ctx.buildAdapter(bodyStep.id, iteration)
      return await runAgentStep(bodyStep, inputs, { runId: ctx.runId, runDir: ctx.runDir, cwd: ctx.cwd, adapter })
    }
  } catch (err) {
    if (err instanceof CommandStepFailedError || err instanceof AgentStepFailedError) {
      await appendJournalEvent(ctx.runDir, ctx.runId, {
        t: 'step.failed',
        stepId: bodyStep.id,
        iteration,
        failure: err.failure,
      })
    }
    throw err
  }
  throw new Error(`step "${bodyStep.id}": kind "${bodyStep.kind}" not supported inside a loop body in M3`)
}
