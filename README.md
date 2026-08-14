# yak

An agentic workflow engine. *It shaves the yak so you don't.*

Reads a YAML DAG, runs steps (shell commands, pure transforms, coding-agent
invocations, human gates), and journals everything to disk so runs resume
exactly where they stopped.

Status: M0–M5 all done (spec.md §8). The `agent → agent → command →
transform` reference shape runs deterministically against fixtures
(`mock` adapter) and for real against an actual bug
(`claude-code` adapter, `fixtures/todo-app/` — see the tutorial at
`docs-site/docs/tutorial.md`, live at
`https://lchase.github.io/yak/docs/tutorial`). `loop`, `map`, `gate`,
and worktree isolation are all implemented and executable, not just IR
types. See `spec.md` §8.

## Current capabilities (M0–M5)

M0 is zero-AI by design — a boring shell pipeline has to cache, resume, and
journal correctly before nondeterministic steps go anywhere near it.

- **Step kinds:** `command` (shell exec, capture stdout/stderr/exitCode),
  `transform` (named pure function from `.yak/transforms.ts`), `agent`
  (prompt from `{ file }`/`{ inline }` with `{{placeholder}}` interpolation,
  `context: 'fresh' | { inherit } | { session }`, Zod schema validation via
  `.yak/schemas.ts`, schema repair loop with retries), `loop` (bounded by
  `maxIterations`, plus a `noProgress` signal/rounds exhaustion check),
  `map` (concurrency cap, per-item failure policy, optional
  `isolation: 'worktree'` — each item forks its own worktree off the
  run's `HEAD`, engine auto-commits before fan-out so items see prior
  steps' output), and `gate` (human decision point, `schema`-validated
  answer, optional `skipIf`).
- **Suspend/resume:** a `gate` or an exhausted budget suspends the run
  (`run.suspended`, reason `gate` | `budget`, `tripped: maxIterations |
  maxTokens | noProgress`) rather than failing it. `yak pending` lists
  every run across the repo awaiting a human answer; `yak resume
  <run-id>` replays and continues; `--interactive` prompts through open
  gates inline instead of exiting to resume later.
- **Worktree isolation:** `yak run --isolation worktree` runs the whole
  workflow inside a fresh git worktree (`.yak/worktrees/<run-id>/`);
  `map` steps can additionally isolate each item into its own sibling
  worktree.
- **Introspection:** `yak graph <workflow>` emits a workflow's DAG as
  Mermaid; `yak watch [<run-id>]` live-tails a run's step statuses in a
  terminal UI; `yak artifacts [<run-id>]` lists a `map` step's per-item
  artifact files.
- **Scheduling:** topological sort, concurrent execution of independent
  steps up to a concurrency cap, artifact-driven eligibility (`needs`/
  `produces`).
- **Validation:** rejects unknown step kinds, duplicate ids, `needs`
  referencing an artifact nothing produces, cycles, and reading
  `<step>.exitCode` downstream of a step with `failOn: 'exitCode'`.
- **Caching:** two-tier content-addressed cache key (`semanticKey` over
  step id + input artifact hashes, `definitionKey` over the step's own
  definition). `cache: strict` (default) re-runs on any mismatch;
  `cache: loose` reuses the artifact and marks the step `stale` when only
  the definition moved.
- **Journal:** append-only JSONL event log of every step's lifecycle.
- **Resume:** `yak resume <run-id>` replays a run's journal to find what
  already completed (a step left `step.started` with no matching
  `step.completed`/`step.failed` is treated as interrupted), recomputes each
  completed step's cache keys against the frozen workflow, reuses the
  on-disk artifact on a match, and re-runs everything from the first
  mismatch downward.
- **Status:** `yak status [<run-id>]` replays a run's journal into per-step
  state (`completed`/`cached`/`stale`/`failed`/`pending`), with no db or
  extra durable state beyond the journal. Defaults to the most recent run
  when `<run-id>` is omitted.
- **Adapters:** `mock` (fixture-driven, deterministic, free) and
  `claude-code` (real, wraps `@anthropic-ai/claude-agent-sdk`). Selected
  with `yak run --adapter mock|claude-code` (default `claude-code`);
  `yak resume` replays the run's original choice and rejects a conflicting
  `--adapter` override. `claude-code.ts`'s own tests stub `query()` at the
  module boundary — CI never calls a real model, per CLAUDE.md.

Not yet implemented: eval-corpus export (`yak export --evals`,
descoped from M4, spec.md §9 decision 10), an API/CLI/YAML reference
beyond spec.md, and npm publish (`docs-site/`'s quickstart still targets
a git-clone install for that reason).
