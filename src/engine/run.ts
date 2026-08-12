import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { flattenSteps } from '../ir/graph.js'
import { loadWorkflowYaml } from '../ir/load.js'
import { normalizeWorkflow } from '../ir/normalize.js'
import type { AdapterId, StepId, Workflow } from '../ir/types.js'
import { validateWorkflow } from '../ir/validate.js'
import { completeGate } from '../steps/gate.js'
import { resolveAgentSchema } from '../steps/agent.js'
import { sha256 } from '../util/hash.js'
import { appendJournalEvent, completedStepsFromJournal, readJournal } from './journal.js'
import { runEligibleSteps } from './scheduler.js'
import { openRequestStepIds, resolveAnswer } from './suspend.js'

const DEFAULT_ADAPTER: AdapterId = 'claude-code'

export interface ExecuteOptions {
  runsDir?: string
  cwd?: string
  cacheDir?: string
  adapter?: AdapterId
}

export interface ExecuteResult {
  runId: string
  runDir: string
  status: 'ok' | 'failed' | 'suspended'
}

export function defaultRunsDir(): string {
  return path.join(process.cwd(), '.runs')
}

function resolveDirs(runsDir: string | undefined, cwd: string | undefined, cacheDir: string | undefined) {
  const resolvedRunsDir = runsDir ?? defaultRunsDir()
  return {
    runsDir: resolvedRunsDir,
    cwd: cwd ?? process.cwd(),
    cacheDir: cacheDir ?? path.join(path.dirname(resolvedRunsDir), '.yak', 'cache'),
  }
}

function generateRunId(): string {
  const iso = new Date().toISOString() // e.g. 2026-08-08T14:03:11.123Z
  const [datePart, timePart] = iso.split('T')
  const time = (timePart ?? '').replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const suffix = randomBytes(2).toString('hex')
  return `${datePart}T${time}Z-${suffix}`
}

export async function executeWorkflowFile(
  workflowPath: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const { runsDir, cwd, cacheDir } = resolveDirs(opts.runsDir, opts.cwd, opts.cacheDir)
  const adapter = opts.adapter ?? DEFAULT_ADAPTER

  const raw = await loadWorkflowYaml(workflowPath)
  const workflow = normalizeWorkflow(raw)
  await validateWorkflow(workflow, cwd)

  const runId = generateRunId()
  const runDir = path.join(runsDir, runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8')

  await appendJournalEvent(runDir, runId, {
    t: 'run.started',
    runId,
    workflow: workflow.name,
    inputHash: sha256(JSON.stringify(workflow)),
    adapter,
  })

  const status = await runEligibleSteps(workflow, { runId, runDir, cwd, cacheDir, adapter })

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}

/** Run ids sort lexicographically by their leading ISO timestamp, so the
 * latest run is just the last directory name — no need to read journals. */
export async function findLatestRunId(runsDir: string): Promise<string | undefined> {
  const entries = await readdir(runsDir).catch(() => [] as string[])
  return entries.sort().at(-1)
}

/** Reads back the workflow a run was started with — the frozen copy
 * `executeWorkflowFile` writes to `runDir/workflow.json`, shared by resume
 * and status so both agree on run-directory layout in one place. */
export async function readRunWorkflow(runDir: string): Promise<Workflow> {
  return JSON.parse(await readFile(path.join(runDir, 'workflow.json'), 'utf8')) as Workflow
}

/**
 * M4 ticket 06: resolves every currently-open pending request (a gate or a
 * loop-exhaustion suspend, ticket 03's journal-based "open" test) against
 * whatever answer file a human has written. A missing or schema-invalid
 * answer throws — the run is left exactly as it was, no journal writes,
 * per ticket 06's "leave suspended, fix and retry" resolution; `yak
 * resume` surfaces the message and exits non-zero. Every request answered
 * validly gets consumed: a gate writes its artifact (`completeGate`), a
 * loop-exhaustion answer is folded into the returned `loopContinuations`
 * map for `runLoopStep` to act on.
 */
async function resolveOpenRequests(
  runId: string,
  runDir: string,
  workflow: Workflow,
  cwd: string,
  events: Awaited<ReturnType<typeof readJournal>>,
): Promise<Map<StepId, { action: 'continue' | 'abort'; addIterations?: number }>> {
  const loopContinuations = new Map<StepId, { action: 'continue' | 'abort'; addIterations?: number }>()
  const openIds = openRequestStepIds(events)
  if (openIds.length === 0) return loopContinuations

  const flatSteps = flattenSteps(workflow.steps)
  const gateAnswerSchema = async (request: { stepId: StepId }) => {
    const step = flatSteps.find((s) => s.id === request.stepId)
    if (!step || step.kind !== 'gate') {
      throw new Error(`pending request for step "${request.stepId}" but no gate step with that id exists`)
    }
    return resolveAgentSchema(step.schema, cwd)
  }

  const resolutions = await Promise.all(openIds.map((stepId) => resolveAnswer(runDir, stepId, gateAnswerSchema)))

  const missing = resolutions.filter((r) => r.status === 'missing')
  const invalid = resolutions.filter((r) => r.status === 'invalid')
  if (missing.length > 0 || invalid.length > 0) {
    const lines = [
      ...missing.map((r) => `  ${r.stepId}: no answer file written yet`),
      ...invalid.map((r) => `  ${r.stepId}: invalid answer\n${r.errors.replace(/^/gm, '    ')}`),
    ]
    throw new Error(`run ${runId} still has unresolved pending requests:\n${lines.join('\n')}`)
  }

  for (const resolution of resolutions) {
    if (resolution.status !== 'ok') continue
    const { request, answer } = resolution

    if (request.kind === 'loop-exhausted') {
      loopContinuations.set(request.stepId, answer as { action: 'continue' | 'abort'; addIterations?: number })
      await appendJournalEvent(runDir, runId, { t: 'gate.answered', stepId: request.stepId })
      continue
    }

    const step = flatSteps.find((s) => s.id === request.stepId)
    if (!step || step.kind !== 'gate') {
      throw new Error(`pending request for step "${request.stepId}" but no gate step with that id exists`)
    }
    await completeGate(step, { runId, runDir, cwd }, answer, { skipped: false })
  }

  return loopContinuations
}

/**
 * Spec §4.4 `yak resume <run-id>`: replay the journal of an interrupted run,
 * mark completed steps, and continue — reusing cache-valid artifacts and
 * re-running only what wasn't (and everything downstream of a mismatch).
 */
export async function resumeRun(runId: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const { runsDir, cwd, cacheDir } = resolveDirs(opts.runsDir, opts.cwd, opts.cacheDir)
  const runDir = path.join(runsDir, runId)

  const workflow = await readRunWorkflow(runDir)

  let events = await readJournal(runDir)
  const loopContinuations = await resolveOpenRequests(runId, runDir, workflow, cwd, events)

  events = await readJournal(runDir)
  const resumeState = completedStepsFromJournal(events)

  // Ticket 09: the adapter choice is a per-run constant, persisted on
  // `run.started` — resuming under a different adapter than the run
  // started with would mix real/fake steps in one journal, so an explicit
  // conflicting override is rejected rather than silently honored.
  const startedEvent = events.find((e) => e.t === 'run.started')
  const persistedAdapter = startedEvent?.adapter ?? DEFAULT_ADAPTER
  if (opts.adapter !== undefined && opts.adapter !== persistedAdapter) {
    throw new Error(
      `run ${runId} started with adapter "${persistedAdapter}" — cannot resume with adapter "${opts.adapter}"`,
    )
  }

  const status = await runEligibleSteps(
    workflow,
    { runId, runDir, cwd, cacheDir, adapter: persistedAdapter, loopContinuations },
    resumeState,
  )

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}
