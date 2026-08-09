import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadWorkflowYaml } from '../ir/load.js'
import { normalizeWorkflow } from '../ir/normalize.js'
import type { Workflow } from '../ir/types.js'
import { validateWorkflow } from '../ir/validate.js'
import { sha256 } from '../util/hash.js'
import { appendJournalEvent, completedStepsFromJournal, readJournal } from './journal.js'
import { runEligibleSteps } from './scheduler.js'

export interface ExecuteOptions {
  runsDir?: string
  cwd?: string
  cacheDir?: string
}

export interface ExecuteResult {
  runId: string
  runDir: string
  status: 'ok' | 'failed'
}

function resolveDirs(runsDir: string | undefined, cwd: string | undefined, cacheDir: string | undefined) {
  const resolvedRunsDir = runsDir ?? path.join(process.cwd(), '.runs')
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

  const raw = await loadWorkflowYaml(workflowPath)
  const workflow = normalizeWorkflow(raw)
  validateWorkflow(workflow)

  const runId = generateRunId()
  const runDir = path.join(runsDir, runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(path.join(runDir, 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf8')

  await appendJournalEvent(runDir, runId, {
    t: 'run.started',
    runId,
    workflow: workflow.name,
    inputHash: sha256(JSON.stringify(workflow)),
  })

  const status = await runEligibleSteps(workflow, { runId, runDir, cwd, cacheDir })

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}

/**
 * Spec §4.4 `yak resume <run-id>`: replay the journal of an interrupted run,
 * mark completed steps, and continue — reusing cache-valid artifacts and
 * re-running only what wasn't (and everything downstream of a mismatch).
 */
export async function resumeRun(runId: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const { runsDir, cwd, cacheDir } = resolveDirs(opts.runsDir, opts.cwd, opts.cacheDir)
  const runDir = path.join(runsDir, runId)

  const workflow = JSON.parse(await readFile(path.join(runDir, 'workflow.json'), 'utf8')) as Workflow

  const events = await readJournal(runDir)
  const resumeState = completedStepsFromJournal(events)

  const status = await runEligibleSteps(workflow, { runId, runDir, cwd, cacheDir }, resumeState)

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}
