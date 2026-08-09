import type { Step, Workflow } from '../ir/types.js'
import { sha256 } from '../util/hash.js'
import { CommandResultSchema, CommandStepFailedError, runCommandStep } from '../steps/command.js'
import { writeArtifact } from './artifacts.js'
import { appendJournalEvent } from './journal.js'

export interface ScheduleContext {
  runId: string
  runDir: string
  cwd: string
}

/** M0: steps run in declared order, no topo sort or concurrency yet. */
export async function runEligibleSteps(
  workflow: Workflow,
  ctx: ScheduleContext,
): Promise<'ok' | 'failed'> {
  for (const step of workflow.steps) {
    const status = await runStep(step, ctx)
    if (status === 'failed') return 'failed'
  }
  return 'ok'
}

async function runStep(step: Step, ctx: ScheduleContext): Promise<'ok' | 'failed'> {
  if (step.kind !== 'command') {
    throw new Error(`step "${step.id}": kind "${step.kind}" not yet supported in M0`)
  }

  const semanticKey = sha256(`${step.id}:${step.run}`)
  const definitionKey = sha256(JSON.stringify(step))

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey,
    definitionKey,
  })

  let result
  try {
    result = runCommandStep(step, ctx.cwd)
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
    const artifact = await writeArtifact(ctx.runDir, step.produces, result, CommandResultSchema)
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
