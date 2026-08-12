import { resumeRun } from '../../engine/run.js'
import type { AdapterId } from '../../ir/types.js'

export async function resumeCommand(runId: string, adapter?: AdapterId): Promise<number> {
  let result: Awaited<ReturnType<typeof resumeRun>>
  try {
    result = await resumeRun(runId, { adapter })
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }

  if (result.status === 'ok') {
    console.log(`run ${result.runId} finished: ok`)
    return 0
  }

  console.error(`run ${result.runId} finished: ${result.status}`)
  return 1
}
