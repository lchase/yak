import { describe, expect, it } from 'vitest'
import type { CommandStep } from '../../src/ir/types.js'
import { CommandStepFailedError, runCommandStep } from '../../src/steps/command.js'

function step(overrides: Partial<CommandStep>): CommandStep {
  return { id: 'test-step', kind: 'command', run: 'true', ...overrides }
}

describe('runCommandStep', () => {
  it('captures stdout, stderr, exitCode from a streamed process', async () => {
    const result = await runCommandStep(
      step({ run: 'printf "line1\\nline2\\n"; printf "err1\\n" 1>&2' }),
      process.cwd(),
    )
    expect(result.stdout).toBe('line1\nline2\n')
    expect(result.stderr).toBe('err1\n')
    expect(result.exitCode).toBe(0)
  })

  it('fails with command-failed on nonzero exit when failOn is exitCode', async () => {
    await expect(runCommandStep(step({ run: 'exit 3' }), process.cwd())).rejects.toMatchObject({
      failure: { reason: 'command-failed', recoverable: false },
    })
  })

  it('does not fail on nonzero exit when failOn is never', async () => {
    const result = await runCommandStep(step({ run: 'exit 3', failOn: 'never' }), process.cwd())
    expect(result.exitCode).toBe(3)
  })

  it('is not affected by idleTimeoutMs when the command produces output within the window', async () => {
    const result = await runCommandStep(step({ run: 'echo hi', idleTimeoutMs: 2_000 }), process.cwd())
    expect(result.stdout).toBe('hi\n')
  })

  it('kills a silent process and fails with reason timeout once idleTimeoutMs elapses', async () => {
    // `sleep` has no SIGTERM handler, so the default action (terminate) fires
    // immediately — this resolves well inside the 5s SIGTERM→SIGKILL grace
    // period, so the test doesn't have to wait it out.
    const failing = runCommandStep(step({ run: 'sleep 5', idleTimeoutMs: 50 }), process.cwd())
    await expect(failing).rejects.toBeInstanceOf(CommandStepFailedError)
    await failing.catch((err: CommandStepFailedError) => {
      expect(err.failure.reason).toBe('timeout')
      expect(err.failure.recoverable).toBe(false)
    })
  })
})
