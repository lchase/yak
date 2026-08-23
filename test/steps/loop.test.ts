import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentAdapterRequest, AgentAdapterResponse } from '../../src/adapters/types.js'
import type { AgentStep, LoopStep } from '../../src/ir/types.js'
import { runLoopStep, type LoopRunContext } from '../../src/steps/loop.js'

function agent(overrides: Partial<AgentStep> & Pick<AgentStep, 'id' | 'prompt'>): AgentStep {
  return { kind: 'agent', ...overrides }
}

class QueueAdapter implements AgentAdapter {
  readonly id = 'queue'
  requests: AgentAdapterRequest[] = []
  private callIndex = 0

  async run(req: AgentAdapterRequest): Promise<AgentAdapterResponse> {
    this.requests.push(req)
    const callIndex = this.callIndex
    this.callIndex += 1
    return {
      output: 'ok',
      sessionId: `sess-${callIndex}`,
      tokens: { input: 1, output: 1 },
      filesChanged: [],
      stopReason: 'complete',
    }
  }
}

let runDir: string
let cacheDir: string

beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), 'yak-loop-run-'))
  cacheDir = await mkdtemp(path.join(tmpdir(), 'yak-loop-cache-'))
})

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

function baseCtx(adapter: AgentAdapter): LoopRunContext {
  return {
    runId: 'r1',
    runDir,
    cwd: process.cwd(),
    cacheDir,
    semanticKey: 'sk',
    definitionKey: 'dk',
    outerArtifactHashes: new Map(),
    buildAdapter: () => adapter,
  }
}

describe('ticket 07: loop-body agent session persistence (freshContext)', () => {
  it('passes the same sessionId to the adapter on every iteration when freshContext is false', async () => {
    const adapter = new QueueAdapter()
    const step: LoopStep = {
      id: 'converse',
      kind: 'loop',
      body: [agent({ id: 'ask', prompt: { inline: 'go' }, produces: 'answer' })],
      until: 'false',
      budget: { maxIterations: 3 },
      onExhausted: 'continue',
      freshContext: false,
    }

    const status = await runLoopStep(step, baseCtx(adapter))

    expect(status).toBe('ok')
    expect(adapter.requests).toHaveLength(3)
    // iteration 1 has no prior session yet
    expect(adapter.requests[0]?.sessionId).toBeUndefined()
    // iterations 2 and 3 resume the session the previous iteration's call returned
    expect(adapter.requests[1]?.sessionId).toBe('sess-0')
    expect(adapter.requests[2]?.sessionId).toBe('sess-1')
  })

  it('never passes a sessionId across iterations when freshContext is true (default)', async () => {
    const adapter = new QueueAdapter()
    const step: LoopStep = {
      id: 'converse',
      kind: 'loop',
      body: [agent({ id: 'ask', prompt: { inline: 'go' }, produces: 'answer' })],
      until: 'false',
      budget: { maxIterations: 3 },
      onExhausted: 'continue',
      freshContext: true,
    }

    const status = await runLoopStep(step, baseCtx(adapter))

    expect(status).toBe('ok')
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests.every((r) => r.sessionId === undefined)).toBe(true)
  })
})
