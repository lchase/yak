import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ArtifactName, Step } from '../ir/types.js'
import { sha256 } from '../util/hash.js'

/** Bumping this poisons every definitionKey — an M0-scale stand-in for the
 * "engine version" term in spec §4.4 until we read it from package.json. */
const ENGINE_VERSION = '0.0.1'

export interface CacheEntry {
  semanticKey: string
  definitionKey: string
  artifactName?: ArtifactName
  artifactHash?: string
  artifact?: unknown
}

export type CacheDecision =
  | { kind: 'miss' }
  | { kind: 'hit'; entry: CacheEntry; stale: boolean }

/** The step fields that define its behavior — everything except id/needs
 * (covered by semanticKey) and produces/cache (bookkeeping, not behavior). */
function definitionPayload(step: Step): unknown {
  switch (step.kind) {
    case 'command':
      return { run: step.run, cwd: step.cwd, failOn: step.failOn, capture: step.capture }
    case 'transform':
      return { fn: step.fn }
    case 'agent':
      return {
        prompt: step.prompt,
        tools: step.tools,
        schema: step.schema,
        model: step.model,
        repairAttempts: step.repairAttempts,
      }
    case 'gate':
      return { schema: step.schema, render: step.render, skipIf: step.skipIf }
    case 'map':
      return {
        over: step.over,
        concurrency: step.concurrency,
        isolation: step.isolation,
        onItemFailure: step.onItemFailure,
        step: step.step,
      }
    case 'loop':
      return {
        until: step.until,
        budget: step.budget,
        onExhausted: step.onExhausted,
        freshContext: step.freshContext,
        body: step.body,
      }
  }
}

/** spec §4.4: definitionKey = sha256(prompt file contents + tools + schema + budget + engine version) */
export function computeDefinitionKey(step: Step): string {
  return sha256(JSON.stringify({ def: definitionPayload(step), engineVersion: ENGINE_VERSION }))
}

/** spec §4.4: semanticKey = sha256(step id + input artifact hashes + adapter id + model id).
 * Ticket 10 / ticket 06: the same numeric slot folds in a loop body step's
 * iteration number or a map item's index — same shape either way, so
 * resume reuses completed iterations/items and only re-runs from the
 * interrupted one forward. Defaults to 0 for a step that's neither. */
export function computeSemanticKey(
  step: Step,
  inputArtifactHashes: Record<ArtifactName, string>,
  iteration = 0,
): string {
  const inputs = Object.keys(inputArtifactHashes)
    .sort()
    .map((name) => `${name}=${inputArtifactHashes[name]}`)
    .join(',')
  const adapterId = step.kind === 'agent' ? 'default' : ''
  const modelId = step.kind === 'agent' ? (step.model ?? '') : ''
  return sha256(`${step.id}|${inputs}|${adapterId}|${modelId}|${iteration}`)
}

/**
 * spec §4.4: strict — a mismatch on either key re-runs the step. loose —
 * reuse the artifact when only definitionKey moved, and report it stale.
 */
export function decideCache(
  cacheMode: 'strict' | 'loose',
  definitionKey: string,
  entry: CacheEntry | undefined,
): CacheDecision {
  if (!entry) return { kind: 'miss' }
  if (entry.definitionKey === definitionKey) return { kind: 'hit', entry, stale: false }
  if (cacheMode === 'loose') return { kind: 'hit', entry, stale: true }
  return { kind: 'miss' }
}

function entryPath(cacheDir: string, semanticKey: string): string {
  return path.join(cacheDir, `${semanticKey}.json`)
}

export async function readCacheEntry(
  cacheDir: string,
  semanticKey: string,
): Promise<CacheEntry | undefined> {
  const raw = await readFile(entryPath(cacheDir, semanticKey), 'utf8').catch(() => undefined)
  return raw === undefined ? undefined : (JSON.parse(raw) as CacheEntry)
}

export async function writeCacheEntry(cacheDir: string, entry: CacheEntry): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  await writeFile(entryPath(cacheDir, entry.semanticKey), JSON.stringify(entry, null, 2), 'utf8')
}
