# Research: auth/credentials for the `claude-code` adapter (M2 #7)

Source ticket: `.scratch/yak-m2/issues/07-auth-credentials.md` — "The `claude-code`
adapter needs to authenticate to actually call the Claude Agent SDK. What does the
SDK expect for credentials by default? Does yak need to do anything itself, or is
this entirely delegated to the SDK? Any implication for CI/the one real-defect
acceptance run?"

## 1. What the SDK expects for credentials by default

The TypeScript Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) does not take
credentials as an argument to `query()`. Authentication is delegated entirely to
environment variables read by the `claude` CLI subprocess that `query()` spawns
under the hood — the SDK's own architecture is "spawn and supervise a `claude` CLI
subprocess," not a direct HTTP client wrapper.

- Default mechanism: the `ANTHROPIC_API_KEY` environment variable, set in the shell
  before running the agent (`export ANTHROPIC_API_KEY=your-api-key`).
  > "The SDK reads the key from the environment of the process that runs your
  > agent; it doesn't load `.env` files automatically. If you keep the key in a
  > `.env` file, load it yourself, for example with the `dotenv` package, before
  > calling the SDK."
  Source: Claude Agent SDK Quickstart (TypeScript), "Set your API key" step,
  https://code.claude.com/docs/en/agent-sdk/quickstart (fetched 2026-08-11).
  Confirmed again in the same page's troubleshooting note: `'If you see "API key
  not found", make sure you've set the ANTHROPIC_API_KEY environment variable in
  the shell where you run your agent. The SDK doesn't load .env files
  automatically.'`

- Alternative backends, also purely via env vars, no SDK-level credential option:
  `CLAUDE_CODE_USE_BEDROCK=1` (+ AWS credentials), `CLAUDE_CODE_USE_ANTHROPIC_AWS=1`
  + `ANTHROPIC_AWS_WORKSPACE_ID` (+ AWS credentials), `CLAUDE_CODE_USE_VERTEX=1` (+
  Google Cloud credentials), `CLAUDE_CODE_USE_FOUNDRY=1` (+ Azure credentials).
  Same source as above ("Set your API key" step).

- Confirmed again at the hosting/production level: "**Anthropic API**: the
  subprocess reads `ANTHROPIC_API_KEY` from its environment. Supply it from your
  secret manager, or set `ANTHROPIC_BASE_URL` to route model calls through a proxy
  that injects the key outside the container."
  Source: Claude Agent SDK — Hosting, "Auth and secrets" section,
  https://code.claude.com/docs/en/agent-sdk/hosting (fetched 2026-08-11).

- There is no `apiKey` field on the TypeScript `Options` type passed to `query()`.
  The nearest related field is `env?: Record<string, string | undefined>`, which —
  if set — **replaces** the subprocess environment wholesale rather than merging
  with `process.env`:
  > "Environment variables. When set, this replaces the subprocess environment
  > instead of merging with `process.env`, so pass `{ ...process.env, YOUR_VAR:
  > 'value' }` to keep inherited variables like `PATH`."
  Source: Claude Agent SDK TypeScript reference,
  https://code.claude.com/docs/en/agent-sdk/typescript (fetched 2026-08-11).
  Restated in the Hosting page's multi-tenant isolation example: "In TypeScript,
  `env` replaces the subprocess environment, so spread `...process.env` to keep
  inherited variables like `PATH` and `ANTHROPIC_API_KEY`." (Python's `env`, by
  contrast, merges on top of the inherited environment — a TS/Python asymmetry
  worth remembering since yak is TypeScript.)
  Source: same Hosting page, "Multi-tenant isolation" section (fetched 2026-08-11).

- Separately, OAuth-based auth (using a Claude Pro/Max subscription/claude.ai login
  instead of an API key) is explicitly disallowed for third-party products built on
  the Agent SDK:
  > "Unless previously approved, Anthropic does not allow third party developers to
  > offer claude.ai login or rate limits for their products, including agents built
  > on the Claude Agent SDK. Please use the API key authentication methods
  > described in this document instead."
  Source: Quickstart page, "Set your API key" step (fetched 2026-08-11). This rules
  out relying on an interactively-authenticated `claude` CLI/OAuth session as yak's
  sanctioned path — yak should assume API-key (`ANTHROPIC_API_KEY`) auth, or one of
  the Bedrock/Vertex/Foundry env-var backends, as the supported mechanisms.

## 2. Does yak-side code need to do anything explicit?

No. `query()` has no credential parameter to fill in — a minimal `claude-code`
adapter calls `query({ prompt, options })` and lets the spawned `claude` subprocess
pick up `ANTHROPIC_API_KEY` (or a Bedrock/Vertex/Foundry equivalent) from
`process.env` automatically. Zero yak-side plumbing is required for the default
case, consistent with "the SDK reads the key from the environment of the process
that runs your agent."

One caveat for the adapter's implementation, about *not accidentally breaking*
default credential discovery rather than doing extra work: if `claude-code.ts` ever
sets a custom `options.env` (e.g. to inject `CLAUDE_CONFIG_DIR`, timeouts, or other
isolation-related env vars), it must spread `...process.env` into that object,
because in the TypeScript SDK `env` **replaces** rather than merges with the
inherited environment. Forgetting this would silently strip `ANTHROPIC_API_KEY` and
break auth, per the Hosting page's multi-tenant isolation example cited in §1.

A second, narrower caveat: if yak ever wants the key to come from a `.env` file or
project config rather than the ambient shell environment, yak-side code (or its
process launcher) would need to load and inject it explicitly — per §1, the SDK will
not read `.env` files on its own.

Net: for M2's default case (the developer's or CI job's shell already has
`ANTHROPIC_API_KEY` exported), the `claude-code` adapter needs **no explicit
credential-handling code** — no config key to read, no field to plumb into
`query()`'s `options`. This is a case where the honest engineering answer is "there
is nothing to build here beyond not breaking it."

## 3. Implications for CI / the one real-defect acceptance run

No separate "headless" or CI-specific auth mode exists at the SDK level — CI and
interactive use converge on the same mechanism: the subprocess reads
`ANTHROPIC_API_KEY` from its environment. The docs treat CI as an ordinary,
supported mode for `query()`, not one requiring different auth setup: "If you don't
need live output (e.g., for background jobs or CI pipelines), you can collect all
messages at once." Source: Quickstart page (fetched 2026-08-11).

- Mechanism for CI: provision `ANTHROPIC_API_KEY` as a secret in whatever CI system
  runs the acceptance job — e.g. a GitHub Actions repository or environment secret
  — and export it into the job's environment (`env: ANTHROPIC_API_KEY:
  ${{ secrets.ANTHROPIC_API_KEY }}` at the job/step level) before the step that
  invokes the `claude-code` adapter's `query()` call. No yak code change is needed
  beyond making sure the process env reaches the subprocess unmodified (the
  `options.env` spreading caveat from §2 — if the adapter ever sets a custom `env`,
  it must not drop the inherited key).
- Mechanism for a local/manual acceptance run: the invoking shell exports
  `ANTHROPIC_API_KEY` before running `yak run ...`, same as the Quickstart's
  `export ANTHROPIC_API_KEY=your-api-key` step — no `.env` file support unless yak
  or its launcher adds `dotenv` loading itself, which is out of scope here.
- Per the Hosting page's "Auth and secrets" guidance, the secret-manager-backed
  pattern (rather than a bare shell env var) is the recommended production
  approach, but functionally both resolve to the same thing the subprocess sees:
  `ANTHROPIC_API_KEY` present in its environment at spawn time.
- Deciding the actual secret value/provisioning process (which GitHub secret name,
  who owns the key, budget/rate-limit policy) is explicitly out of scope for this
  research pass per the ticket — this only confirms the mechanism.
- Packaging note relevant to CI images, not credentials per se: `npm ci
  --omit=optional` skips the optional dependency that bundles the native `claude`
  binary, so a CI Docker image built with that flag would need Claude Code
  installed natively and `pathToClaudeCodeExecutable` set. Source: Quickstart page,
  install note (fetched 2026-08-11). Worth flagging alongside auth since both are
  "things that silently break the acceptance run in CI but not locally."

## Sources consulted (primary)

- Claude Agent SDK Quickstart (TypeScript) —
  https://code.claude.com/docs/en/agent-sdk/quickstart, "Set your API key" step and
  troubleshooting note, fetched 2026-08-11.
- Claude Agent SDK TypeScript reference (Options / `env` field) —
  https://code.claude.com/docs/en/agent-sdk/typescript, fetched 2026-08-11.
- Claude Agent SDK — Hosting — https://code.claude.com/docs/en/agent-sdk/hosting,
  "Auth and secrets" and "Multi-tenant isolation" sections, fetched 2026-08-11.
- Local repo check: `package.json` at repo root lists no `@anthropic-ai/*`
  dependency yet (only `commander`, `jexl`, `p-limit`, `picocolors`, `yaml`, `zod`,
  `zod-to-json-schema`), and `node_modules/` has no `@anthropic-ai` package
  installed — the `claude-code` adapter has not been scaffolded yet in this
  worktree, and `src/` has no `ANTHROPIC_API_KEY`, `query(`, or `claude-code`
  references to reconcile against. Checked 2026-08-11.

## Not verified directly

I did not have a local `node_modules` install of `@anthropic-ai/claude-agent-sdk`
in this worktree to inspect the shipped `.d.ts` for `Options` first-hand (see
"Local repo check" above); the "no `apiKey` field, `env` replaces not merges"
claims are taken directly from the current TypeScript SDK reference and Hosting
docs pages instead, which describe the same `.d.ts` surface. Once the SDK is added
as a dependency for the `claude-code` adapter work, it would be worth a quick
`grep -n "apiKey\|env" node_modules/@anthropic-ai/claude-agent-sdk/**/*.d.ts` to
confirm the type-level shape matches this doc-derived description exactly.
