import type { JournalEnvelope, Step, StepId } from '../ir/types.js'

export type StepState = 'completed' | 'cached' | 'stale' | 'failed' | 'pending'

export interface StepStatus {
  stepId: StepId
  status: StepState
}

/**
 * `yak status`: per-step state read entirely from the journal, keyed by
 * whatever `step.completed`/`step.failed` last said about each step id — a
 * later `step.started` with nothing after it (interrupted mid-flight) leaves
 * the step `pending`, same as one that never ran.
 */
export function stepStatusesFromJournal(steps: Step[], events: JournalEnvelope[]): StepStatus[] {
  const stateByStep = new Map<StepId, StepState>()

  for (const event of events) {
    if (event.t === 'step.started') {
      stateByStep.set(event.stepId, 'pending')
    } else if (event.t === 'step.completed') {
      stateByStep.set(event.stepId, event.stale ? 'stale' : event.cached ? 'cached' : 'completed')
    } else if (event.t === 'step.failed') {
      stateByStep.set(event.stepId, 'failed')
    }
  }

  return steps.map((step) => ({ stepId: step.id, status: stateByStep.get(step.id) ?? 'pending' }))
}
