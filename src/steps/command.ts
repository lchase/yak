import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import type { CommandStep, StepFailure } from '../ir/types.js'

export const CommandResultSchema = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().optional(),
})
export type CommandResult = z.infer<typeof CommandResultSchema>

export class CommandStepFailedError extends Error {
  readonly failure: StepFailure

  constructor(failure: StepFailure) {
    super(failure.detail)
    this.failure = failure
  }
}

/** `extraEnv` is how a `map` item step reaches its own item — the minimal
 * per-item data channel a shell command has, the analog of an agent
 * step's `{{...}}` prompt templating. Merged over the inherited
 * environment, never replacing it. */
export function runCommandStep(step: CommandStep, cwd: string, extraEnv?: Record<string, string>): CommandResult {
  const capture = step.capture ?? ['stdout', 'stderr', 'exitCode']
  const failOn = step.failOn ?? 'exitCode'

  const spawned = spawnSync(step.run, {
    cwd: step.cwd ?? cwd,
    shell: true,
    encoding: 'utf8',
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  })

  if (spawned.error) {
    throw new CommandStepFailedError({
      reason: 'command-failed',
      detail: `command "${step.run}" failed to start: ${spawned.error.message}`,
      recoverable: false,
    })
  }

  const exitCode = spawned.status ?? (spawned.signal ? 1 : 0)

  const result: CommandResult = {}
  if (capture.includes('stdout')) result.stdout = spawned.stdout
  if (capture.includes('stderr')) result.stderr = spawned.stderr
  if (capture.includes('exitCode')) result.exitCode = exitCode

  if (failOn === 'exitCode' && exitCode !== 0) {
    throw new CommandStepFailedError({
      reason: 'command-failed',
      detail: `command "${step.run}" exited with code ${exitCode}`,
      recoverable: false,
    })
  }

  return result
}
