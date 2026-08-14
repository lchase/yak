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

interface Review {
  approved: boolean
  feedback: string
}

/** yak cookbook: review-and-revise loop. `review` is undefined on the
 * loop's first iteration (no prior round yet) — this is the one place
 * that's allowed to check for that; an agent step's `{{review.feedback}}`
 * template placeholder would throw instead. */
export function prepFeedback(inputs: Record<string, unknown>): unknown {
  const review = inputs['review'] as Review | undefined
  return review === undefined ? '(first attempt — no prior feedback yet)' : review.feedback
}

interface VitestJsonReport {
  numFailedTests: number
  numTotalTests: number
}

/** yak cookbook: review-and-revise loop. Parses `vitest run
 * --reporter=json`'s stdout into the numeric signal the loop's
 * `noProgress` budget reads (`numFailedTests` — 0 means `until` should
 * already be true via the review step's own judgment, since a truly
 * green suite is what "approved" is gated on). */
export function parseTestResult(inputs: Record<string, unknown>): unknown {
  const testRaw = inputs['testRaw'] as CommandResult
  const report = JSON.parse(testRaw.stdout ?? '{}') as Partial<VitestJsonReport>
  return {
    numFailedTests: report.numFailedTests ?? 0,
    numTotalTests: report.numTotalTests ?? 0,
  }
}

/** yak cookbook: fan-out-over-issues map. Static, deterministic batch —
 * the point of this pattern is the fan-out mechanics (concurrency,
 * per-item worktree isolation, auto-commit-before-fork), not sourcing
 * the batch itself. */
export function batchIssues(): unknown {
  return [
    {
      id: 'capitalize',
      file: 'fixtures/batch-issues/src/capitalize.ts',
      test: 'fixtures/batch-issues/test/capitalize.test.ts',
    },
    {
      id: 'clamp',
      file: 'fixtures/batch-issues/src/clamp.ts',
      test: 'fixtures/batch-issues/test/clamp.test.ts',
    },
    {
      id: 'isPalindrome',
      file: 'fixtures/batch-issues/src/isPalindrome.ts',
      test: 'fixtures/batch-issues/test/isPalindrome.test.ts',
    },
  ]
}
