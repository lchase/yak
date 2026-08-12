import path from 'node:path'
import { executeWorkflowFile } from '../../engine/run.js'
import type { AdapterId } from '../../ir/types.js'

export async function runCommand(workflowPath: string, adapter?: AdapterId): Promise<number> {
  const result = await executeWorkflowFile(path.resolve(workflowPath), { adapter })

  if (result.status === 'ok') {
    console.log(`run ${result.runId} finished: ok`)
    return 0
  }

  console.error(`run ${result.runId} finished: failed`)
  return 1
}
