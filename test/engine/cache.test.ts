import { describe, expect, it } from 'vitest'
import {
  computeDefinitionKey,
  computeSemanticKey,
  decideCache,
  type CacheEntry,
} from '../../src/engine/cache.js'
import type { CommandStep } from '../../src/ir/types.js'

function command(overrides: Partial<CommandStep> & Pick<CommandStep, 'id'>): CommandStep {
  return { kind: 'command', run: 'echo hi', ...overrides }
}

describe('computeSemanticKey', () => {
  it('is stable for the same step id and input artifact hashes', () => {
    const step = command({ id: 'a' })
    const key1 = computeSemanticKey(step, { input: 'hash1' })
    const key2 = computeSemanticKey(step, { input: 'hash1' })
    expect(key1).toBe(key2)
  })

  it('is order-independent over input artifact names', () => {
    const step = command({ id: 'a' })
    const key1 = computeSemanticKey(step, { a: '1', b: '2' })
    const key2 = computeSemanticKey(step, { b: '2', a: '1' })
    expect(key1).toBe(key2)
  })

  it('changes when an input artifact hash changes', () => {
    const step = command({ id: 'a' })
    const key1 = computeSemanticKey(step, { input: 'hash1' })
    const key2 = computeSemanticKey(step, { input: 'hash2' })
    expect(key1).not.toBe(key2)
  })

  it('changes when the step id changes', () => {
    const key1 = computeSemanticKey(command({ id: 'a' }), {})
    const key2 = computeSemanticKey(command({ id: 'b' }), {})
    expect(key1).not.toBe(key2)
  })
})

describe('computeDefinitionKey', () => {
  it('is stable for an unchanged step definition', () => {
    const step = command({ id: 'a', run: 'echo hi' })
    expect(computeDefinitionKey(step)).toBe(computeDefinitionKey({ ...step }))
  })

  it('changes when the run command changes', () => {
    const key1 = computeDefinitionKey(command({ id: 'a', run: 'echo hi' }))
    const key2 = computeDefinitionKey(command({ id: 'a', run: 'echo bye' }))
    expect(key1).not.toBe(key2)
  })

  it('does not change when id or needs change (not part of the definition)', () => {
    const key1 = computeDefinitionKey(command({ id: 'a', run: 'echo hi' }))
    const key2 = computeDefinitionKey(command({ id: 'b', run: 'echo hi', needs: ['x'] }))
    expect(key1).toBe(key2)
  })
})

describe('decideCache', () => {
  const entry: CacheEntry = {
    semanticKey: 'sem',
    definitionKey: 'def',
    artifactName: 'out',
    artifactHash: 'h1',
    artifact: { ok: true },
  }

  it('misses when there is no prior entry', () => {
    expect(decideCache('strict', 'def', undefined)).toEqual({ kind: 'miss' })
  })

  it('hits, not stale, when both keys match', () => {
    expect(decideCache('strict', 'def', entry)).toEqual({ kind: 'hit', entry, stale: false })
  })

  it('strict misses when definitionKey moved', () => {
    expect(decideCache('strict', 'def-changed', entry)).toEqual({ kind: 'miss' })
  })

  it('loose hits, marked stale, when only definitionKey moved', () => {
    expect(decideCache('loose', 'def-changed', entry)).toEqual({ kind: 'hit', entry, stale: true })
  })
})
