import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { JournalEnvelope, JournalEvent } from '../ir/types.js'

function journalPath(runDir: string): string {
  return path.join(runDir, 'journal.jsonl')
}

export async function appendJournalEvent(
  runDir: string,
  runId: string,
  event: JournalEvent,
): Promise<void> {
  const envelope: JournalEnvelope = { ...event, at: new Date().toISOString(), runId }
  await mkdir(runDir, { recursive: true })
  await appendFile(journalPath(runDir), `${JSON.stringify(envelope)}\n`, 'utf8')
}

export async function readJournal(runDir: string): Promise<JournalEnvelope[]> {
  const contents = await readFile(journalPath(runDir), 'utf8').catch(() => '')
  return contents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEnvelope)
}
