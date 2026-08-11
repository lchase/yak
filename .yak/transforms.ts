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

interface Plan {
  summary: string
  steps: string[]
}

export function summarizeAgentFixture(inputs: Record<string, unknown>): unknown {
  const plan = inputs['plan'] as Plan
  const check = inputs['check-result'] as CommandResult
  return {
    planSummary: plan.summary,
    stepCount: plan.steps.length,
    checked: check.exitCode === 0,
  }
}
