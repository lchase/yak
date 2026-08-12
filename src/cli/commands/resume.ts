import { resumeRun } from '../../engine/run.js'
import type { AdapterId } from '../../ir/types.js'

export async function resumeCommand(runId: string, adapter?: AdapterId): Promise<number> {
  const result = await resumeRun(runId, { adapter })

  if (result.status === 'ok') {
    console.log(`run ${result.runId} finished: ok`)
    return 0
  }

  console.error(`run ${result.runId} finished: failed`)
  return 1
}
