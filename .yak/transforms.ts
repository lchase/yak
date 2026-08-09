interface CommandResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export function summarizeChecks(inputs: Record<string, unknown>): unknown {
  const lint = inputs['lint-result'] as CommandResult
  const test = inputs['test-result'] as CommandResult
  return {
    lintPassed: lint.exitCode === 0,
    testPassed: test.exitCode === 0,
    ok: lint.exitCode === 0 && test.exitCode === 0,
  }
}
