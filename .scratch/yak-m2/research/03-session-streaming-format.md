# Research: Session/streaming transcript format (Claude Agent SDK)

Ticket: `.scratch/yak-m2/issues/03-session-streaming-format.md`

## 0. What's already in this repo

`package.json` does **not** yet depend on `@anthropic-ai/claude-agent-sdk` — the
dependency table in spec.md §12 lists it as "M2 only," and M2 hasn't started.
`grep -rn "claude-agent-sdk\|@anthropic-ai\|query(" src/` returns nothing: no
code in this repo imports or touches the SDK yet. `src/adapters/` currently
has only `types.ts` (the `AgentAdapter` interface, matching spec §5 verbatim)
and `mock.ts` (the M1 fixture-driven adapter). `claude-code.ts` does not exist.

Unlike the model-selection research (`02-model-selection.md`), which was
docs-only because no local install existed, **this research installed the
package directly** (`npm pack @anthropic-ai/claude-agent-sdk@0.3.228` into a
scratch dir, unpacked, read `sdk.d.ts` — 7,494 lines) as a primary source
alongside Anthropic's hosted docs. `0.3.228` was `npm view`'s reported
`latest` at fetch time (2026-08-11). Findings below cite line numbers in that
`sdk.d.ts` where applicable — treat those as the ground truth over the hosted
docs' prose summaries, which are written at a friendlier abstraction level
and (confirmed below) sometimes lag or simplify the actual union.

## 1. The message/event stream `query()` emits

### 1.1 The real union is much bigger than the docs describe

The hosted docs (`agent-loop` page) describe "five core message types"
(`SystemMessage`, `AssistantMessage`, `UserMessage`, `StreamEvent`,
`ResultMessage`) as the ones needed to drive the loop, and separately note
"Both SDKs also yield observability events... not required to drive the
loop." The `.d.ts` confirms this undersells the surface. The actual exported
union, `sdk.d.ts:4184`:

```ts
export declare type SDKMessage =
  | SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay
  | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage | SDKStatusMessage | SDKAPIRetryMessage
  | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage
  | SDKModelRefusalNoFallbackMessage | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage
  | SDKPluginInstallMessage | SDKToolProgressMessage | SDKAuthStatusMessage
  | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskUpdatedMessage
  | SDKTaskProgressMessage | SDKBackgroundTasksChangedMessage
  | SDKThinkingTokensMessage | SDKSessionStateChangedMessage
  | SDKWorkerShuttingDownMessage | SDKCommandsChangedMessage
  | SDKNotificationMessage | SDKFilesPersistedEvent | SDKToolUseSummaryMessage
  | SDKMemoryRecallMessage | SDKRateLimitEvent | SDKElicitationCompleteMessage
  | SDKPermissionDeniedMessage | SDKPromptSuggestionMessage
  | SDKMirrorErrorMessage | SDKInformationalMessage
  | SDKConversationResetMessage
```

That's **37 member types**, not 5. Every one of them is a real thing `query()`
can yield for `src/adapters/claude-code.ts` to handle (or, more realistically
for M2, ignore-and-pass-through). Grouped by what they're for:

**Core loop (drives the turn-by-turn logic)** — these are the ones the
adapter's `run()` implementation actually needs to branch on:

- **`SDKSystemMessage`** (`type: 'system'`, `subtype: 'init'`) — one per
  session, near-immediately after `query()` starts. Full shape,
  `sdk.d.ts:4601-4645`:
  ```ts
  export declare type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';
    agents?: string[];
    apiKeySource: ApiKeySource;
    betas?: string[];
    claude_code_version: string;
    cwd: string;
    tools: string[];
    mcp_servers: { name: string; status: string }[];
    model: string;
    permissionMode: PermissionMode;
    slash_commands: string[];
    output_style: string;
    skills: string[];
    plugins: { name: string; path: string; version?: string }[];
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
    capabilities?: string[];
    uuid: UUID;
    session_id: string;
  };
  ```
  This is the earliest point `session_id` is observable in the stream (see §3).

- **`SDKAssistantMessage`** (`type: 'assistant'`) — one per assistant turn
  (including the final text-only turn). `sdk.d.ts:3019-3064`:
  ```ts
  export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;                 // the raw Anthropic API message —
                                            // content blocks (text/tool_use/
                                            // thinking) live at message.content
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError;      // 'rate_limit' | 'overloaded' | ...
    uuid: UUID;
    session_id: string;
    request_id?: string;
    resumed_from_incomplete_thinking?: true;
    supersedes?: UUID[];                   // refusal-fallback supersede
    aborted?: true;                        // truncated by interrupt/abort
    subagent_type?: string;
    task_description?: string;
    timestamp?: string;
  };
  ```
  `message` is `BetaMessage`, i.e. a full Anthropic Messages API response
  object (`id`, `content: ContentBlock[]`, `usage`, `stop_reason`, etc.) — this
  is where `Turn completed: ${message.message.content.length} content blocks`
  and per-message token usage (`message.message.usage.input_tokens` /
  `.output_tokens`) come from, per the docs' cost-tracking sample.

- **`SDKUserMessage`** (`type: 'user'`) — emitted after each tool execution
  (tool_result content sent back to Claude) and for any streamed-in user
  input. `sdk.d.ts:4772-4816`:
  ```ts
  export declare type SDKUserMessage = {
    type: 'user';
    message: MessageParam;                 // role: 'user', content incl. tool_result blocks
    parent_tool_use_id: string | null;
    isSynthetic?: boolean;
    tool_use_result?: unknown;              // structured per-tool Output object
    priority?: 'now' | 'next' | 'later';
    origin?: SDKMessageOrigin;
    shouldQuery?: boolean;
    timestamp?: string;
    uuid?: UUID;
    session_id?: string;
    subagent_type?: string;
    task_description?: string;
  };
  ```
  There's also **`SDKUserMessageReplay`** (`sdk.d.ts:4818+`), structurally
  identical, used when replaying history on resume rather than a live
  tool-result turn.

- **`SDKPartialAssistantMessage`** (`type: 'stream_event'`) — only emitted
  when `options.includePartialMessages: true`. `sdk.d.ts:4321-4328`:
  ```ts
  export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';
    event: BetaRawMessageStreamEvent;   // raw Anthropic API SSE-style event
                                          // (message_start, content_block_delta
                                          // text/input_json deltas, message_stop, ...)
    parent_tool_use_id: string | null;
    uuid: UUID;
    session_id: string;
    ttft_ms?: number;
  };
  ```
  This is the text-delta / token-by-token streaming granularity. It is
  **opt-in** — default is off, and yak's adapter has no reason to turn it on
  for a headless batch step (see §2).

- **`SDKResultMessage`** — terminal message for the `query()` call, a
  discriminated union of two subtypes, `sdk.d.ts:4440-4511`:
  ```ts
  export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;

  export declare type SDKResultSuccess = {
    type: 'result'; subtype: 'success';
    duration_ms: number; duration_api_ms: number;
    is_error: boolean; num_turns: number;
    result: string;                       // final text output
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;               // main-loop-only tokens
    modelUsage: Record<string, ModelUsage>;// per-model totals, incl. subagents
    permission_denials: SDKPermissionDenial[];
    structured_output?: unknown;
    deferred_tool_use?: SDKDeferredToolUse;
    terminal_reason?: TerminalReason;
    uuid: UUID;
    session_id: string;
    // + several timing-diagnostic fields (ttft_ms, warm_spare_claimed, ...)
  };

  export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns'
           | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    duration_ms: number; duration_api_ms: number;
    is_error: boolean; num_turns: number;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: TerminalReason;
    uuid: UUID;
    session_id: string;
  };
  ```
  Note: **no `result` field on the error variant** — matches the hosted docs'
  "The `result` field... is only present on the `success` variant" note.
  `session_id` is present on *both* variants, "so you can track cost and
  resume even after errors" (agent-loop.md, verbatim).

**System sub-events** (all `type: 'system'`, distinguished by `subtype`, and
each is its own top-level union member rather than nested under
`SDKSystemMessage` — confirmed by both the hosted docs ("each subtype other
than `'init'` is its own type in the `SDKMessage` union") and the `.d.ts`):
`SDKCompactBoundaryMessage` (`sdk.d.ts:3108-3141`, fires post-compaction, has
`compact_metadata: { trigger, pre_tokens, post_tokens?, preserved_segment?,
preserved_messages? }`), `SDKPermissionDeniedMessage` (`sdk.d.ts:4339-4362`,
auto-deny events), `SDKTaskNotificationMessage` /
`SDKTaskStartedMessage` / `SDKTaskUpdatedMessage` / `SDKTaskProgressMessage`
(subagent/background-task progress), `SDKWorkerShuttingDownMessage`,
`SDKAuthStatusMessage`, `SDKStatusMessage`, `SDKInformationalMessage`,
`SDKPromptSuggestionMessage`, `SDKConversationResetMessage`, etc.

**Hook/control/observability events** — `SDKHookStartedMessage` /
`SDKHookProgressMessage` / `SDKHookResponseMessage` (hook lifecycle, only
with `includeHookEvents`-style config), `SDKAPIRetryMessage`,
`SDKControlRequestProgressMessage`, `SDKModelRefusalFallbackMessage` /
`SDKModelRefusalNoFallbackMessage` (the automatic-safety-fallback behavior
`02-model-selection.md` §4 already flagged), `SDKRateLimitEvent`,
`SDKMirrorErrorMessage`, `SDKFilesPersistedEvent`, `SDKToolProgressMessage`,
`SDKToolUseSummaryMessage`, `SDKMemoryRecallMessage`,
`SDKElicitationCompleteMessage`, `SDKThinkingTokensMessage`,
`SDKSessionStateChangedMessage`, `SDKBackgroundTasksChangedMessage`,
`SDKCommandsChangedMessage`, `SDKLocalCommandOutputMessage`,
`SDKPluginInstallMessage`. None of these are documented in prose on the
hosted docs pages fetched for this research; their shapes exist only in the
`.d.ts` comments. yak's adapter has no use for most of these in a headless,
one-shot-per-step model (§3.6 of spec.md: "no channel to ask the human"), but
they will appear in the stream and the adapter must not crash on an unknown
`type`.

### 1.2 Errors

There is no distinct "error message" type in the union for request-level
failures — `SDKResultError` (subtype `error_during_execution` /
`error_max_turns` / `error_max_budget_usd` /
`error_max_structured_output_retries`) is how a fatal-to-the-turn condition
surfaces *as data in the stream*. Separately, per the hosted `agent-loop`
docs (verbatim): "A single-shot `query()` call yields the final result
message, then **raises** [TypeScript: throws] after yielding an error result
... connection or process failures yield no result message" — i.e. some
failures (process crash, connection drop) never produce any `SDKResultMessage`
at all and only surface as a thrown/rejected promise around the
`for await` loop. `src/adapters/claude-code.ts` needs a `try/catch` around
the iteration (not just a `for await` per the docs' own example) to catch
that class of failure and translate it into the spec's `StepFailure` (`{
reason: 'adapter-error', ... }`, spec.md §3.6).

Per-turn assistant errors (rate limits, overload, auth failures) surface as
the optional `error?: SDKAssistantMessageError` field on `SDKAssistantMessage`
itself (`sdk.d.ts:3023,3066`: `'authentication_failed' | 'oauth_org_not_allowed'
| 'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' |
'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens'`) — a
non-fatal, in-stream signal rather than a thrown exception.

## 2. Should `sessions/<step>.jsonl` be the raw SDK stream verbatim?

**Recommendation: yes, one JSON object per line, essentially verbatim — with
one deliberate omission (`includePartialMessages` stays off) and one caveat
about a non-JSON-serializable field.**

Reconciling with spec §4.1's framing ("raw adapter transcript, for debugging
only"):

1. **The stream is already JSONL-shaped.** Every `SDKMessage` union member is
   a plain, JSON-serializable object (`type` discriminator + fields), and
   `query()` yields them one at a time from an async generator. Writing
   `JSON.stringify(message) + '\n'` per yielded message *is* the natural
   shape — no projection/reshaping is needed to get to line-delimited JSON.
   This matches how the SDK itself persists sessions to disk: the hosted
   `sessions` doc says sessions are stored as
   `~/.claude/projects/<encoded-cwd>/*.jsonl` — Anthropic's own session
   format is already one-message-per-line JSONL, so mirroring the stream
   verbatim into `sessions/<step>.jsonl` is consistent with the SDK's own
   convention, not an unusual choice for yak to make.

2. **Don't turn on `includePartialMessages`.** If enabled, `SDKPartialAssistantMessage`
   floods the stream with raw Anthropic SSE deltas (`content_block_delta`
   with incremental `text`/`partial_json`) that "only make sense reassembled"
   — exactly the risk the ticket asked about. Since yak's `agent` step is a
   one-shot batch call (spec.md §3.2, §5: adapter `run()` returns a single
   `Promise`, not a live-streaming UI), there's no consumer for token-level
   deltas — `sessions/<step>.jsonl`'s stated purpose is debugging, and full
   assistant turns (`SDKAssistantMessage`) already give per-turn granularity
   with each turn's complete text/tool_use content. Leaving
   `includePartialMessages` at its default (`false`, `sdk.d.ts:1655`) is the
   correct choice for this file's purpose — it's not a decision the writer
   needs to make at write time, it's a decision to make once when
   constructing the `query()` call.

3. **Redundancy is real but expected and low-cost.** `SDKUserMessage.tool_use_result`
   duplicates tool output that's also embedded as content blocks in
   `message.message.content` (tool_result blocks); `modelUsage` on the result
   message duplicates running per-turn `usage` on assistant messages. This is
   the same kind of redundancy Anthropic's own on-disk session JSONL carries.
   Since this file is explicitly "for debugging only" (not read by the
   engine's cache/resume logic, which lives in the journal per spec §4.2 and
   the `AgentAdapterResponse` return value per §5), the redundancy is an
   acceptable cost for completeness — a human debugging a step wants the
   ability to see exactly what the model saw and produced, without yak's
   adapter code deciding in advance which fields matter.

4. **One field is not directly JSON-serializable as-is:** `AbortSignal`
   never appears inside `SDKMessage` — the signal lives on yak's own
   `AgentAdapterRequest.signal` (`src/adapters/types.ts:8`), not in anything
   the SDK yields, so this is a non-issue in practice. The one thing worth
   flagging: `SDKAssistantMessage.message` (`BetaMessage`) and
   `SDKUserMessage.message` (`MessageParam`) are plain data (Anthropic API
   message shapes) — no functions, no circular refs, no `Buffer`s observed in
   the `.d.ts`. `JSON.stringify` should work directly on every message in the
   union without a custom replacer, based on the type shapes read. This
   wasn't verified against a live run's actual bytes (no live SDK call was
   made for this research — see caveats below), so treat "no custom
   serialization needed" as a design assumption to confirm with a smoke test
   in the M2 implementation, not a guarantee.

5. **What the writer should actually do:** for each `message` yielded by the
   `for await (const message of query(...))` loop, append
   `JSON.stringify(message) + '\n'` to `sessions/<step>.jsonl`, unconditionally,
   for every `SDKMessage` type — don't filter by `type` at write time. Filtering
   belongs in a future `yak sessions <run-id> <step>` viewer/pretty-printer, not
   in the writer. This keeps the writer trivial (one `fs.appendFileSync` call
   per message, or a stream, no branching logic to maintain) and keeps the
   ticket's own framing intact: "raw adapter transcript" means raw, and
   "for debugging only" means yak's own cache/resume/journal logic must
   **not** parse this file back — those come from the `AgentAdapterResponse`
   the adapter's `run()` returns (§5's `output`, `sessionId`, `tokens`,
   `filesChanged`, `stopReason`), which the adapter constructs by reducing
   over the stream as it writes it, not by re-reading the JSONL later.

## 3. Session ID and resume mechanics

### 3.1 Where `session_id` comes from, and when it's first available

`session_id: string` is a field on nearly every `SDKMessage` variant that
carries session context (`SDKSystemMessage`, `SDKAssistantMessage`,
`SDKUserMessage` (optional there), `SDKResultMessage` both variants,
`SDKPartialAssistantMessage`, `SDKCompactBoundaryMessage`, etc. — confirmed
by grep across `sdk.d.ts`). Two authoritative capture points, per the hosted
`sessions` doc (verbatim): "Read it from the `session_id` field on the result
message ... which is present on every result regardless of success or error.
**In TypeScript the ID is also available earlier as a direct field on the
init `SystemMessage`**; in Python it's nested inside `SystemMessage.data`."

So concretely for `src/adapters/claude-code.ts`:

- **Earliest availability: the first message in the stream.** `SDKSystemMessage`
  (`subtype: 'init'`) is yielded near the very start of `query()` — before any
  assistant turn — and carries `session_id: string` directly
  (`sdk.d.ts:4644`). This is stable for the life of the `query()` call (barring
  `forkSession`, see below).
- **Guaranteed availability: the terminal `SDKResultMessage`.** Both
  `SDKResultSuccess` and `SDKResultError` carry `session_id: string`
  (`sdk.d.ts:4467`, `4510`) as a **non-optional** field — this is the value
  the docs' own examples capture into a local `sessionId` variable, and it's
  the safe fallback if the adapter didn't capture it off the `init` message
  for some reason (e.g. the process died before parsing that far — unlikely
  but the `init` message's `session_id` isn't literally guaranteed to survive
  a stream that errors before it's fully read either, if the adapter is
  written defensively).

**Recommendation for `AgentAdapterResponse.sessionId` (`src/adapters/types.ts:14`):**
capture `session_id` off the `SDKSystemMessage` (`subtype: 'init'`) as soon as
it arrives — it's available before any tool call or assistant text, so it's
safe to journal/log/use even if the step is later aborted mid-run — but treat
the `SDKResultMessage.session_id` as authoritative for the final returned
value, since it's the field the SDK documents as "present on every result
regardless of success or error" and is what downstream `resume` calls are
documented to use.

### 3.2 Mechanics of actually resuming

Three distinct, mutually-interacting `Options` fields (`sdk.d.ts:1346+`),
quoted from the `.d.ts` doc comments:

```ts
/** Continue the most recent conversation in the current directory instead
 *  of starting a new one. Mutually exclusive with `resume`. */
continue?: boolean;                                    // sdk.d.ts:1406-1409

/** Session ID to resume. Loads the conversation history from the specified
 *  session. */
resume?: string;                                        // sdk.d.ts:1824-1827

/** Use a specific session ID for the conversation instead of an
 *  auto-generated one. Must be a valid UUID. Cannot be used with `continue`
 *  or `resume` unless `forkSession` is also set (to specify a custom ID for
 *  the forked session). */
sessionId?: string;                                      // sdk.d.ts:1828-1833

/** When true, resumed sessions will fork to a new session ID rather than
 *  continuing the previous session. Use with `resume`. */
forkSession?: boolean;                                    // sdk.d.ts:1521-1524

/** When resuming, only resume messages up to and including the message
 *  with this UUID. Use with `resume`. This allows you to resume from a
 *  specific point in the conversation. */
resumeSessionAt?: string;                                 // sdk.d.ts:1834-1841
```

Mechanically, to resume a prior session in a subsequent `query()` call: pass
`options: { resume: sessionId }` where `sessionId` is the value captured per
§3.1 above. The hosted `sessions` doc's TypeScript sample (verbatim):

```typescript
const sessionId = "..."; // captured from a prior query()'s result/init message

for await (const message of query({
  prompt: "Now implement the refactoring you suggested",
  options: {
    resume: sessionId,
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"]
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

What the SDK does with `resume` mechanically: it loads the session's JSONL
transcript from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (or
`$CLAUDE_CONFIG_DIR/projects/...` if set) and replays it as prior context
before evaluating the new prompt — "the full context from previous turns is
restored: files that were read, analysis that was performed, and actions
that were taken" (hosted docs, verbatim). `<encoded-cwd>` is the absolute
`cwd` with every non-alphanumeric character replaced by `-`. This is on-disk
state **local to the machine** — resuming from a different host requires
either moving that `.jsonl` file or configuring a `sessionStore` adapter
(`Options.sessionStore`, `sdk.d.ts` — mirrors transcripts to an external
backend so any host can resume). Resume lookup also crosses git worktrees in
current CLI versions (v2.1.223+; older bundled CLIs scope the search to just
the originating directory and its worktrees) — worth flagging since spec.md
§5.1 and §9(#8) already put yak's agent steps inside worktrees.

Two related knobs, useful for the M2 implementation to know about even
though full resume *semantics* (what "resume" should mean for a yak
`context: { session: ... }` step, spec §3.4) is out of scope here per the
ticket:

- **`forkSession: true`** used with `resume` branches into a *new* session ID
  that starts as a copy of the resumed session's history, leaving the
  original untouched — the fork's own ID shows up on the `init` message of
  that call, distinct from the `resume` target's ID.
- **`resumeSessionAt`** truncates the resumed history to a specific message
  UUID rather than the full transcript — resume-to-a-point rather than
  resume-to-the-end.
- **`sessionId` (option, not to be confused with the returned field)** lets
  the caller pre-assign a UUID for a *new* session rather than letting the
  SDK auto-generate one — not needed for a first-time `resume`, but relevant
  if yak ever wants its own step-id-derived UUIDs instead of SDK-generated
  ones for journal correlation.

### 3.3 Out of scope, flagged not solved

What "resume" should *mean* at the yak IR level — i.e., whether
`context: { session: 'prior-step-id' }` (spec.md §3.4) maps onto SDK
`resume`, `continue`, or something yak constructs itself from stored
artifacts, and how that interacts with the "3-chain warning" the spec already
calls out — is explicitly a separate question (per the ticket: "ties into
ticket 06"). This research only establishes the SDK-level mechanics (`resume`
takes a session ID string, loads that session's on-disk transcript, and
restores full turn history); it does not attempt to design yak's
context-boundary semantics on top of it.

## Caveats / what wasn't verified

- **No live `query()` call was made.** All message shapes above come from
  the published `.d.ts` (a static, compile-time source of truth for field
  names and types) and Anthropic's hosted prose docs — not from observing an
  actual run's byte stream. The claim in §2 that every yielded message
  JSON-serializes cleanly with no custom replacer is inferred from the type
  shapes, not confirmed against real output. This should be smoke-tested
  early in the M2 implementation (e.g. the first working version of
  `claude-code.ts` should assert `JSON.stringify` round-trips every message
  type it sees against a real fixture-generating run, before relying on it
  for the mock adapter's fixtures too).
- **Docs vs `.d.ts` disagreement.** The hosted `agent-loop` doc's "five core
  message types" framing is materially incomplete next to the 37-member
  `.d.ts` union — treated the `.d.ts` as authoritative throughout this
  document per instructions, but flagging this explicitly since a future
  reader skimming only the hosted docs would design the adapter around a much
  narrower message surface than what `query()` can actually emit.
- **Version drift risk.** `0.3.228` was the reported `latest` at fetch time
  (2026-08-11 per WebFetch dates, `npm view` run same session). The SDK is
  pre-1.0 (`0.x`) and, per `02-model-selection.md`'s own finding that the V2
  session API was removed in `0.3.142`, the surface has already had breaking
  removals within the 0.3.x line. Pin the exact version in `package.json`
  (not a caret range) if `sessions/<step>.jsonl`'s shape needs to stay stable
  across yak upgrades of the SDK, and re-diff `sdk.d.ts` against this
  document when bumping.
- **`errors: string[]`** on `SDKResultError` — the `.d.ts` doesn't document
  the string format/content beyond the type; treat as opaque human-readable
  text for the `StepFailure.detail` field rather than something to
  pattern-match on.

## Sources

- `sdk.d.ts` from `@anthropic-ai/claude-agent-sdk@0.3.228` (installed via
  `npm pack` into a scratch dir and read directly — primary source for every
  type shape quoted above; line numbers cited inline).
- https://code.claude.com/docs/en/agent-sdk/agent-loop — message-type
  overview, loop lifecycle, result-handling semantics, error/throw behavior
  of single-shot `query()`. Fetched 2026-08-11 via WebFetch.
- https://code.claude.com/docs/en/agent-sdk/sessions — session ID capture,
  `continue`/`resume`/`forkSession` semantics, on-disk session file location
  and cross-host resume guidance. Fetched 2026-08-11 via WebFetch.
- https://code.claude.com/docs/en/agent-sdk/typescript — attempted for the
  full `SDKMessage` union verbatim; page exceeded WebFetch's summarization
  window ("content truncated due to length") and the returned summary was
  materially incomplete relative to `sdk.d.ts` — superseded by the `.d.ts`
  read directly.
- Context7 `/websites/code_claude_en_agent-sdk` — cross-check queries for
  message types and session capture; consistent with, but less complete
  than, the hosted-doc WebFetches and the `.d.ts`.
- `npm view @anthropic-ai/claude-agent-sdk version` — `0.3.228` reported as
  latest, fetched 2026-08-11.
- This repo: `package.json`, `src/adapters/types.ts`, `src/adapters/mock.ts`,
  `spec.md` §4.1/§4.2/§5 — grounding for what yak already expects from the
  adapter contract and for confirming no existing SDK usage in `src/`.
