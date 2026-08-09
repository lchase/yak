import { resumeRun } from '../../engine/run.js'

export async function resumeCommand(runId: string): Promise<number> {
  const result = await resumeRun(runId)

  if (result.status === 'ok') {
    console.log(`run ${result.runId} finished: ok`)
    return 0
  }

  console.error(`run ${result.runId} finished: failed`)
  return 1
}
