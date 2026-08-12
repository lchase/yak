import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { AgentStepFailedError } from '../../src/steps/agent.js'
import type { AgentAdapterRequest } from '../../src/adapters/types.js'

const queryMock = vi.fn<(params: { prompt: string; options?: Options }) => Query>()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options?: Options }) => queryMock(params),
}))

/** Minimal `Query`: an async generator over the given messages, plus the
 * control methods the adapter never calls (only `for await` iteration and
 * `Symbol.asyncIterator` matter here). */
function fakeQuery(messages: SDKMessage[]): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for (const m of messages) yield m
  }
  return gen() as unknown as Query
}

function resultSuccess(overrides: Partial<Extract<SDKMessage, { type: 'result'; subtype: 'success' }>> = {}) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 12, output_tokens: 34 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'u1',
    session_id: 'session-1',
    ...overrides,
  } as unknown as SDKMessage
}

function resultError(
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries',
  errors: string[] = ['boom'],
): SDKMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: 'u1',
    session_id: 'session-1',
  } as unknown as SDKMessage
}

const baseReq: AgentAdapterRequest = {
  prompt: 'do the thing',
  tools: ['Read', 'Edit'],
  cwd: '/work',
  signal: new AbortController().signal,
}

let runDir: string

beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), 'yak-claude-code-'))
  queryMock.mockReset()
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(runDir, { recursive: true, force: true })
})

describe('ClaudeCodeAdapter', () => {
  it('builds options with tools, bypassPermissions, and no resume for a fresh call', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([resultSuccess()]))

    const adapter = new ClaudeCodeAdapter(runDir, 'plan')
    await adapter.run(baseReq)

    expect(queryMock).toHaveBeenCalledTimes(1)
    const call = queryMock.mock.calls[0]![0]
    expect(call.prompt).toBe('do the thing')
    expect(call.options).toMatchObject({
      cwd: '/work',
      tools: ['Read', 'Edit'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
    expect(call.options?.resume).toBeUndefined()
  })

  it('maps a sessionId on the request to options.resume', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([resultSuccess()]))

    const adapter = new ClaudeCodeAdapter(runDir, 'code')
    await adapter.run({ ...baseReq, sessionId: 'prior-session' })

    const call = queryMock.mock.calls[0]![0]
    expect(call.options?.resume).toBe('prior-session')
  })

  it('maps model and schema through to options.model / options.outputFormat', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([resultSuccess()]))

    const adapter = new ClaudeCodeAdapter(runDir, 'plan')
    await adapter.run({ ...baseReq, model: 'claude-sonnet-5', schema: { type: 'object' } })

    const call = queryMock.mock.calls[0]![0]
    expect(call.options?.model).toBe('claude-sonnet-5')
    expect(call.options?.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } })
  })

  it('reduces a success result into AgentAdapterResponse and writes the raw stream to sessions/<step>.jsonl', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    const success = resultSuccess({ structured_output: { summary: 'ok' } })
    queryMock.mockReturnValue(fakeQuery([success]))

    const adapter = new ClaudeCodeAdapter(runDir, 'plan')
    const res = await adapter.run(baseReq)

    expect(res).toEqual({
      output: { summary: 'ok' },
      sessionId: 'session-1',
      tokens: { input: 12, output: 34 },
      filesChanged: [],
      stopReason: 'complete',
    })

    const log = await readFile(path.join(runDir, 'sessions', 'plan.jsonl'), 'utf8')
    const lines = log.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([success])
  })

  it('falls back to result.result as output when no structured_output is present', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([resultSuccess({ result: 'plain text' })]))

    const adapter = new ClaudeCodeAdapter(runDir, 'plan')
    const res = await adapter.run(baseReq)

    expect(res.output).toBe('plain text')
  })

  it('collects filesChanged from Edit/Write/NotebookEdit tool_use blocks', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    const assistantMessage = {
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: 'u0',
      session_id: 'session-1',
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/work/b.ts' } },
          { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/work/c.ts' } },
          { type: 'text', text: 'hi' },
        ],
      },
    } as unknown as SDKMessage
    queryMock.mockReturnValue(fakeQuery([assistantMessage, resultSuccess()]))

    const adapter = new ClaudeCodeAdapter(runDir, 'code')
    const res = await adapter.run(baseReq)

    expect(res.filesChanged).toEqual(['/work/a.ts', '/work/b.ts'])
  })

  it('throws tool-denied when permission_denials is non-empty, even on a success result', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(
      fakeQuery([
        resultSuccess({
          permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: {} }],
        }),
      ]),
    )

    const adapter = new ClaudeCodeAdapter(runDir, 'code')

    await expect(adapter.run(baseReq)).rejects.toMatchObject({
      failure: { reason: 'tool-denied', recoverable: false },
    })
  })

  it('maps error_max_budget_usd to budget-exhausted', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([resultError('error_max_budget_usd')]))

    const adapter = new ClaudeCodeAdapter(runDir, 'code')

    await expect(adapter.run(baseReq)).rejects.toMatchObject({
      failure: { reason: 'budget-exhausted', recoverable: false },
    })
  })

  it('maps error_max_turns to a non-recoverable adapter-error', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([resultError('error_max_turns')]))

    const adapter = new ClaudeCodeAdapter(runDir, 'code')

    await expect(adapter.run(baseReq)).rejects.toMatchObject({
      failure: { reason: 'adapter-error', recoverable: false },
    })
  })

  it('maps error_during_execution to a recoverable adapter-error', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([resultError('error_during_execution')]))

    const adapter = new ClaudeCodeAdapter(runDir, 'code')

    await expect(adapter.run(baseReq)).rejects.toMatchObject({
      failure: { reason: 'adapter-error', recoverable: true },
    })
  })

  it('throws a recoverable adapter-error when the stream ends without a result message', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockReturnValue(fakeQuery([]))

    const adapter = new ClaudeCodeAdapter(runDir, 'code')

    await expect(adapter.run(baseReq)).rejects.toMatchObject({
      failure: { reason: 'adapter-error', recoverable: true },
    })
  })

  it('propagates a thrown/rejected query() as a recoverable adapter failure path (via the caller)', async () => {
    const { ClaudeCodeAdapter } = await import('../../src/adapters/claude-code.js')
    queryMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })

    const adapter = new ClaudeCodeAdapter(runDir, 'code')

    await expect(adapter.run(baseReq)).rejects.toThrow('spawn failed')
    await expect(adapter.run(baseReq)).rejects.not.toBeInstanceOf(AgentStepFailedError)
  })
})
