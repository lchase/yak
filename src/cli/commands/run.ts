import path from 'node:path'
import { executeWorkflowFile } from '../../engine/run.js'
import type { AdapterId } from '../../ir/types.js'

const EX_SUSPEND = 78

export async function runCommand(workflowPath: string, adapter?: AdapterId): Promise<number> {
  const result = await executeWorkflowFile(path.resolve(workflowPath), { adapter })

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
