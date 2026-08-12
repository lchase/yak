import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJournal } from '../../src/engine/journal.js'
import { executeWorkflowFile, readRunWorkflow, resumeRun } from '../../src/engine/run.js'
import { loopStatusFromJournal } from '../../src/engine/status.js'
import type { LoopStep } from '../../src/ir/types.js'

const LOOP_SUCCESS_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'loop-success.yaml')
const LOOP_BUDGET_EXHAUSTED_WORKFLOW = path.join(
  process.cwd(),
  'test',
  'workflows',
  'loop-budget-exhausted.yaml',
)
const LOOP_NO_PROGRESS_WORKFLOW = path.join(process.cwd(), 'test', 'workflows', 'loop-no-progress.yaml')

let dir: string
let cwd: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yak-loop-'))
  cwd = await mkdtemp(path.join(tmpdir(), 'yak-loop-cwd-'))
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
})

describe('loop combinator: success', () => {
  it('runs the body repeatedly until `until` is satisfied, then stops', async () => {
    const result = await executeWorkflowFile(LOOP_SUCCESS_WORKFLOW, { runsDir: path.join(dir, '.runs'), cwd })

    expect(result.status).toBe('ok')

    const events = await readJournal(result.runDir)
    const iterations = events.filter((e) => e.t === 'loop.iteration')
    // the counter trips exit 0 on the 3rd `test` run, and `until` is checked
    // after each full iteration — so iterations 1 and 2 fail `until` and get
    // a loop.iteration event; iteration 3 satisfies `until` and returns
    // before ever journaling a 3rd loop.iteration event.
    expect(iterations.map((e) => (e as { n: number }).n)).toEqual([1, 2])

    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted.map((e) => (e as { iteration?: number }).iteration)).toEqual([1, 2, 3])
  })

  it('writes a per-iteration artifact file for each body step run', async () => {
    const result = await executeWorkflowFile(LOOP_SUCCESS_WORKFLOW, { runsDir: path.join(dir, '.runs'), cwd })
    expect(result.status).toBe('ok')

    for (const iteration of [1, 2, 3]) {
      const raw = await readFile(path.join(result.runDir, 'artifacts', `testresult.${iteration}.json`), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.exitCode).toBe(iteration === 3 ? 0 : 1)
    }
  })
})

describe('loop combinator: budget exhaustion', () => {
  it('suspends after maxIterations, never satisfying until, default onExhausted', async () => {
    const result = await executeWorkflowFile(LOOP_BUDGET_EXHAUSTED_WORKFLOW, {
      runsDir: path.join(dir, '.runs'),
      cwd,
    })

    expect(result.status).toBe('suspended')

    const events = await readJournal(result.runDir)
    const suspended = events.find((e) => e.t === 'run.suspended')
    expect(suspended).toMatchObject({
      t: 'run.suspended',
      reason: 'exhausted',
      loopStepId: 'fix-until-green',
      iteration: 3,
      tripped: 'maxIterations',
    })

    // ran exactly maxIterations (3) full iterations, per ticket 03: checks
    // happen at iteration boundaries only, not mid-iteration.
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(3)

    const finished = events.find((e) => e.t === 'run.finished')
    expect(finished).toMatchObject({ status: 'suspended' })
  })
})

describe('loop combinator: no-progress exhaustion', () => {
  it('suspends after `rounds` consecutive non-improving signal readings, before maxIterations', async () => {
    const result = await executeWorkflowFile(LOOP_NO_PROGRESS_WORKFLOW, { runsDir: path.join(dir, '.runs'), cwd })

    expect(result.status).toBe('suspended')

    const events = await readJournal(result.runDir)
    const suspended = events.find((e) => e.t === 'run.suspended')
    expect(suspended).toMatchObject({
      t: 'run.suspended',
      reason: 'exhausted',
      loopStepId: 'fix-until-green',
      iteration: 2,
      tripped: 'noProgress',
    })

    // tripped by noProgress (rounds: 2) well before maxIterations (5) would
    // ever have been reached.
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(2)
  })
})

describe('M4 tickets 02/06/08: resuming a loop-exhausted run', () => {
  it('leaves the run suspended, untouched, when no answer file exists yet', async () => {
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_BUDGET_EXHAUSTED_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    await expect(resumeRun(result.runId, { runsDir, cwd })).rejects.toThrow(
      /fix-until-green.*no answer file/s,
    )

    // confirm it's a no-op — no further iterations were run, no journal change
    const events = await readJournal(result.runDir)
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(3)
    expect(events.some((e) => e.t === 'gate.answered')).toBe(false)
  })

  it('fails the loop step with budget-exhausted on an "abort" answer', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_BUDGET_EXHAUSTED_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'fix-until-green.answer.json'),
      JSON.stringify({ action: 'abort' }),
      'utf8',
    )

    const resumed = await resumeRun(result.runId, { runsDir, cwd })
    expect(resumed.status).toBe('failed')

    const events = await readJournal(result.runDir)
    const failure = events.find((e) => e.t === 'step.failed' && e.stepId === 'fix-until-green')
    expect(failure).toMatchObject({ failure: { reason: 'budget-exhausted' } })
  })

  it('resumes from the tripped iteration on a "continue" answer with addIterations', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const runsDir = path.join(dir, '.runs')

    // A variant that succeeds only on the 4th `test` run — out of reach of
    // the original maxIterations: 3, reachable only via addIterations.
    // The counter file's path is embedded directly (no shell env
    // indirection) so the command is portable across /bin/sh variants.
    const counterFile = path.join(cwd, 'counter')
    const workflowPath = path.join(cwd, 'loop-continue.yaml')
    await writeFile(
      workflowPath,
      `name: loop-continue
version: "1"
steps:
  - id: fix-until-green
    loop:
      until: "testresult.exitCode == 0"
      budget:
        maxIterations: 3
      body:
        - id: implement
          command: { run: "true" }
          produces: code
        - id: test
          needs: [code]
          command: { run: "c=$(cat ${counterFile} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${counterFile}; test $c -ge 4 && exit 0 || exit 1", capture: [exitCode], failOn: never }
          produces: testresult
`,
      'utf8',
    )

    const result = await executeWorkflowFile(workflowPath, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    await mkdir(path.join(result.runDir, 'pending'), { recursive: true })
    await writeFile(
      path.join(result.runDir, 'pending', 'fix-until-green.answer.json'),
      JSON.stringify({ action: 'continue', addIterations: 2 }),
      'utf8',
    )

    const resumed = await resumeRun(result.runId, { runsDir, cwd })
    expect(resumed.status).toBe('ok')

    const events = await readJournal(resumed.runDir)
    // 3 iterations before suspend + 1 more after resume = 4 `test` starts
    const testStarted = events.filter((e) => e.t === 'step.started' && e.stepId === 'test')
    expect(testStarted).toHaveLength(4)
    expect(testStarted.map((e) => (e as { iteration?: number }).iteration)).toEqual([1, 2, 3, 4])
  })
})

describe('ticket 09: yak status detail for a loop', () => {
  it('reports iteration, budget, and the latest noProgress signal while suspended', async () => {
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_NO_PROGRESS_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('suspended')

    const workflow = await readRunWorkflow(result.runDir)
    const loopStep = workflow.steps.find((s) => s.id === 'fix-until-green') as LoopStep
    const events = await readJournal(result.runDir)

    const detail = loopStatusFromJournal(loopStep, events)

    expect(detail).toMatchObject({
      stepId: 'fix-until-green',
      state: 'suspended',
      iteration: 2,
      maxIterations: 5,
      noProgressSignal: 1,
    })
  })

  it('reports state completed with the final iteration once until is satisfied', async () => {
    const runsDir = path.join(dir, '.runs')
    const result = await executeWorkflowFile(LOOP_SUCCESS_WORKFLOW, { runsDir, cwd })
    expect(result.status).toBe('ok')

    const workflow = await readRunWorkflow(result.runDir)
    const loopStep = workflow.steps.find((s) => s.id === 'fix-until-green') as LoopStep
    const events = await readJournal(result.runDir)

    const detail = loopStatusFromJournal(loopStep, events)

    expect(detail).toMatchObject({ stepId: 'fix-until-green', state: 'completed', iteration: 3 })
  })
})
