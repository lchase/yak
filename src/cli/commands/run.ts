import path from 'node:path'
import { readJournal } from '../../engine/journal.js'
import { executeWorkflowFile, readRunWorkflow, resumeRun } from '../../engine/run.js'
import { openRequestStepIds, readPendingRequest, writeAnswer } from '../../engine/suspend.js'
import type { AdapterId, RunIsolation } from '../../ir/types.js'
import { promptForAnswer, terminalAsk } from '../interactive.js'

const EX_SUSPEND = 78

export interface RunCommandOptions {
  adapter?: AdapterId
  interactive?: boolean
  isolation?: RunIsolation
}

/**
 * M4 ticket 09: when a round suspends with multiple gates open at once,
 * `--interactive` prompts through all of them in one invocation, in
 * workflow declaration order — not the order the scheduler happened to
 * open them in, which can vary with concurrency.
 */
async function answerOpenRequestsInteractively(runId: string, runDir: string): Promise<void> {
  const events = await readJournal(runDir)
  const openIds = new Set(openRequestStepIds(events))
  if (openIds.size === 0) return

  const workflow = await readRunWorkflow(runDir)
  const orderedIds = workflow.steps.map((s) => s.id).filter((id) => openIds.has(id))
  const ask = terminalAsk(process.stdin, process.stdout)

  for (const stepId of orderedIds) {
    const request = await readPendingRequest(runDir, stepId)
    if (!request) continue
    const answer = await promptForAnswer(request, ask, (text) => console.log(text))
    await writeAnswer(runDir, stepId, answer)
  }
}

export async function runCommand(workflowPath: string, opts: RunCommandOptions = {}): Promise<number> {
  let result = await executeWorkflowFile(path.resolve(workflowPath), {
    adapter: opts.adapter,
    isolation: opts.isolation,
  })

  while (opts.interactive && result.status === 'suspended') {
    await answerOpenRequestsInteractively(result.runId, result.runDir)
    result = await resumeRun(result.runId, { adapter: opts.adapter })
  }

  if (result.status === 'ok') {
    console.log(`run ${result.runId} finished: ok`)
    return 0
  }

  if (result.status === 'suspended') {
    console.log(`run ${result.runId} suspended — resume with:\n  yak resume ${result.runId}`)
    return EX_SUSPEND
  }

  console.error(`run ${result.runId} finished: failed`)
  return 1
}
