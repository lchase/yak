import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { query, type Options, type SDKMessage, type SDKResultError } from '@anthropic-ai/claude-agent-sdk'
import type { StepFailure } from '../ir/types.js'
import { AgentStepFailedError } from '../steps/agent.js'
import type { AgentAdapter, AgentAdapterRequest, AgentAdapterResponse } from './types.js'

/**
 * M2 tickets 01/10: `tools` is the SDK's availability allowlist (not the
 * approval-only `allowedTools` spec.md §5 originally, and incorrectly,
 * named) — it restricts what the model can call independent of
 * `permissionMode`. `bypassPermissions` is the only `permissionMode` that
 * needs no `canUseTool` callback, which yak can't provide (agent steps
 * have no channel to ask a human, spec §3.6). Fixed engine-wide, not a
 * per-step IR field — see ticket 10.
 */
const FIXED_OPTIONS = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
} as const

/** File-mutating tools whose `file_path` input we scan for `filesChanged`. */
const FILE_MUTATING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

function collectFilesChanged(message: SDKMessage, into: Set<string>): void {
  if (message.type !== 'assistant') return
  for (const block of message.message.content) {
    if (block.type !== 'tool_use') continue
    if (!FILE_MUTATING_TOOLS.has(block.name)) continue
    const input = block.input
    if (input && typeof input === 'object' && 'file_path' in input) {
      const filePath = (input as { file_path: unknown }).file_path
      if (typeof filePath === 'string') into.add(filePath)
    }
  }
}

/**
 * M2 ticket 04's failure-mode -> StepFailure mapping table. Permission
 * denials are checked ahead of this (they can appear on a success result
 * too); this only classifies the terminal error subtypes.
 */
function mapResultError(result: SDKResultError): StepFailure {
  const detail = result.errors.length > 0 ? result.errors.join('; ') : `${result.subtype} (no detail)`
  switch (result.subtype) {
    case 'error_max_budget_usd':
      return { reason: 'budget-exhausted', detail, recoverable: false }
    case 'error_max_turns':
      // Same prompt/session would hit the same cap again — not schema-repair's job (§3.5 is schema-invalid only).
      return { reason: 'adapter-error', detail, recoverable: false }
    case 'error_max_structured_output_retries':
      return { reason: 'adapter-error', detail, recoverable: false }
    case 'error_during_execution':
    default:
      return { reason: 'adapter-error', detail, recoverable: true }
  }
}

/**
 * Real `AgentAdapter` wrapping the Claude Agent SDK's `query()`. One
 * instance per step invocation — mirrors `MockAdapter`'s per-step
 * construction in `scheduler.ts` — since `sessions/<step>.jsonl` (spec
 * §4.1) needs the run directory and step id that `AgentAdapterRequest`
 * itself doesn't carry.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code'

  constructor(
    private readonly runDir: string,
    private readonly stepId: string,
  ) {}

  async run(req: AgentAdapterRequest): Promise<AgentAdapterResponse> {
    const abortController = new AbortController()
    if (req.signal.aborted) abortController.abort(req.signal.reason)
    else req.signal.addEventListener('abort', () => abortController.abort(req.signal.reason))

    const options: Options = {
      ...FIXED_OPTIONS,
      abortController,
      cwd: req.cwd,
      tools: req.tools,
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}),
      // §3.4 `context: { session }` resume vs `'fresh'` (ticket 06): a
      // prior sessionId genuinely replays that session's transcript via
      // `resume`; omitting it is `'fresh'` — no explicit teardown needed,
      // and this Options object is always freshly built per call, never
      // reused/mutated across steps.
      ...(req.sessionId !== undefined ? { resume: req.sessionId } : {}),
      ...(req.schema !== undefined
        ? { outputFormat: { type: 'json_schema', schema: req.schema as Record<string, unknown> } }
        : {}),
    }

    const sessionLogPath = path.join(this.runDir, 'sessions', `${this.stepId}.jsonl`)
    await mkdir(path.dirname(sessionLogPath), { recursive: true })

    const filesChanged = new Set<string>()
    let result: Extract<SDKMessage, { type: 'result' }> | undefined

    // Ticket 03: write the raw SDKMessage stream verbatim, one JSON object
    // per line, unfiltered — already JSONL-shaped, matches the SDK's own
    // on-disk session format.
    for await (const message of query({ prompt: req.prompt, options })) {
      await appendFile(sessionLogPath, `${JSON.stringify(message)}\n`, 'utf8')
      collectFilesChanged(message, filesChanged)
      if (message.type === 'result') result = message
    }

    if (!result) {
      // Ticket 04: a thrown/rejected promise around the `for await` loop is
      // one failure mode; a stream that ends with no result message at all
      // (still possible if the process exits without yielding one) is the
      // same class of failure — treated identically.
      throw new AgentStepFailedError({
        reason: 'adapter-error',
        detail: `claude-code adapter for step "${this.stepId}": query() stream ended without a result message`,
        recoverable: true,
      })
    }

    if (result.permission_denials.length > 0) {
      throw new AgentStepFailedError({
        reason: 'tool-denied',
        detail: `tool call(s) denied: ${result.permission_denials.map((d) => d.tool_name).join(', ')}`,
        recoverable: false,
      })
    }

    if (result.subtype !== 'success') {
      throw new AgentStepFailedError(mapResultError(result))
    }

    return {
      output: result.structured_output ?? result.result,
      sessionId: result.session_id,
      tokens: { input: result.usage.input_tokens, output: result.usage.output_tokens },
      filesChanged: [...filesChanged].sort(),
      stopReason: 'complete',
    }
  }
}
