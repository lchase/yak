import path from 'node:path'
import { readJournal } from '../../engine/journal.js'
import { defaultRunsDir, findLatestRunId, readRunWorkflow } from '../../engine/run.js'
import { loopStatusFromJournal, stepStatusesFromJournal } from '../../engine/status.js'

export interface StatusOptions {
  runsDir?: string
}

export async function statusCommand(runId: string | undefined, opts: StatusOptions = {}): Promise<number> {
  const runsDir = opts.runsDir ?? defaultRunsDir()
  const resolvedRunId = runId ?? (await findLatestRunId(runsDir))

  if (!resolvedRunId) {
    console.error('no runs found')
    return 1
  }

  const runDir = path.join(runsDir, resolvedRunId)
  const workflow = await readRunWorkflow(runDir).catch(() => undefined)
  if (!workflow) {
    console.error(`run ${resolvedRunId} not found`)
    return 1
  }

  const events = await readJournal(runDir)
  const statuses = stepStatusesFromJournal(workflow.steps, events)

  console.log(`run ${resolvedRunId}:`)
  for (const { stepId, status } of statuses) {
    console.log(`  ${stepId}: ${status}`)

    const step = workflow.steps.find((s) => s.id === stepId)
    if (step?.kind === 'loop') {
      const detail = loopStatusFromJournal(step, events)
      const budget =
        detail.maxTokens !== undefined
          ? `iteration ${detail.iteration}/${detail.maxIterations}, tokens ${detail.consumedTokens}/${detail.maxTokens}`
          : `iteration ${detail.iteration}/${detail.maxIterations}, tokens ${detail.consumedTokens}`
      const signal = detail.noProgressSignal !== undefined ? `, noProgress signal ${detail.noProgressSignal}` : ''
      console.log(`    ${budget}${signal}`)
    }
  }

  return 0
}
