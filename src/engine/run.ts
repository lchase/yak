import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadWorkflowYaml } from '../ir/load.js'
import { normalizeWorkflow } from '../ir/normalize.js'
import { sha256 } from '../util/hash.js'
import { appendJournalEvent } from './journal.js'
import { runEligibleSteps } from './scheduler.js'

export interface ExecuteOptions {
  runsDir?: string
  cwd?: string
}

export interface ExecuteResult {
  runId: string
  runDir: string
  status: 'ok' | 'failed'
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
  const runsDir = opts.runsDir ?? path.join(process.cwd(), '.runs')
  const cwd = opts.cwd ?? process.cwd()

  const raw = await loadWorkflowYaml(workflowPath)
  const workflow = normalizeWorkflow(raw)

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

  const status = await runEligibleSteps(workflow, { runId, runDir, cwd })

  await appendJournalEvent(runDir, runId, { t: 'run.finished', status })

  return { runId, runDir, status }
}
