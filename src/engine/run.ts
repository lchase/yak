import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadWorkflowYaml } from '../ir/load.js'
import { normalizeWorkflow } from '../ir/normalize.js'
import type { AdapterId, Workflow } from '../ir/types.js'
import { validateWorkflow } from '../ir/validate.js'
import { sha256 } from '../util/hash.js'
import { appendJournalEvent, completedStepsFromJournal, readJournal } from './journal.js'
import { runEligibleSteps } from './scheduler.js'

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
 * Spec §4.4 `yak resume <run-id>`: replay the journal of an interrupted run,
 * mark completed steps, and continue — reusing cache-valid artifacts and
 * re-running only what wasn't (and everything downstream of a mismatch).
 */
export async function resumeRun(runId: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const { runsDir, cwd, cacheDir } = resolveDirs(opts.runsDir, opts.cwd, opts.cacheDir)
  const runDir = path.join(runsDir, runId)

  const workflow = await readRunWorkflow(runDir)

  const events = await readJournal(runDir)

  // Ticket 04: a loop-exhausted run is unresumable in M3 — there is no
  // gate/answer protocol yet (M4's job) to give `yak resume` anything to
  // act on, so it fails loud rather than silently re-entering the loop
  // with a fresh budget (which would mask a genuinely stuck loop) or
  // no-op re-reporting the suspended state (redundant with `yak status`).
  const lastSuspended = [...events].reverse().find((e) => e.t === 'run.suspended')
  if (lastSuspended && lastSuspended.t === 'run.suspended' && lastSuspended.reason !== 'gate') {
    throw new Error(
      `run ${runId} is suspended (loop "${lastSuspended.loopStepId}" exhausted: ` +
        `${lastSuspended.tripped}) — resuming a loop-exhausted run isn't implemented ` +
        `until M4's gate/answer protocol lands`,
    )
  }

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
    { runId, runDir, cwd, cacheDir, adapter: persistedAdapter },
    resumeState,
  )

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}
