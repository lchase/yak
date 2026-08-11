# yak

An agentic workflow engine. *It shaves the yak so you don't.*

Reads a YAML DAG, runs steps (shell commands, pure transforms, coding-agent
invocations, human gates), and journals everything to disk so runs resume
exactly where they stopped.

Status: M0 done. M1 done — `mock` adapter, `agent` step, Zod schema
validation, schema repair loop; the `agent → agent → command → transform`
reference-workflow subset runs deterministically against fixtures. See
`spec.md` §8 and `.scratch/yak-m1/`.

## Current capabilities (M0 + M1)

M0 is zero-AI by design — a boring shell pipeline has to cache, resume, and
journal correctly before nondeterministic steps go anywhere near it.

- **Step kinds:** `command` (shell exec, capture stdout/stderr/exitCode),
  `transform` (named pure function from `.yak/transforms.ts`), and `agent`
  (prompt from `{ file }`/`{ inline }` with `{{placeholder}}` interpolation,
  `context: 'fresh' | { inherit } | { session }`, Zod schema validation via
  `.yak/schemas.ts`, schema repair loop with retries against the `mock`
  adapter). `gate`, `map`, and `loop` are in the IR types but not yet
  executable — the scheduler rejects them.
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

Not yet implemented: gate/map/loop step execution, the real `claude-code`
adapter, budget enforcement, worktree isolation, the CLI beyond
`run`/`resume`/`status`.
