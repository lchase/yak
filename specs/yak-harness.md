# yak-harness — spec

**Status:** design complete, ready to hand to an implementation effort.
Assembled from the `yak-factory-harness` wayfinder effort (map + tickets
`01`–`07` + `prototype-04-gate-bridge.md`, kept under `.scratch/` and
not version-controlled). Section references like "ticket 02" point at
those issue files for the full reasoning behind each decision.

---

## 1. Overview

`yak-harness` is a **new, standalone package** that sits around
[yak](../spec.md) and owns one job: being the boundary between a
GitHub Issues backlog and yak. It is a **stateless cron reconciler**,
co-located with yak on a persistent-filesystem box. Each run ("tick")
it:

1. **Manages a GitHub Issues backlog by label** — launches a `yak run`
   for each qualifying issue, and drives a status-label state machine
   as those runs progress, fail, or open PRs.
2. **Bridges yak's gate protocol** (yak spec §4.5) — when a run
   suspends on a `gate`, posts the rendered prompt as an issue comment,
   parses a human's reply into a schema-valid answer, and resumes the
   run.

**yak's engine stays entirely ignorant that GitHub exists.** The
harness drives yak only through its documented CLI (`yak run`,
`yak resume`, `yak pending`) and its on-disk journal / `pending/`
contract.

### Non-goals

See §11. In brief: no multi-provider tracker abstraction, no changes to
yak's engine, no idea-to-qualified-issue refinement (that is external —
a human applies the qualifying label to work they have already scoped),
no PR-revision loop, no aggregate observability dashboard.

---

## 2. Mental model

The same as yak's: **a build system whose compilers are
nondeterministic.** The harness is the reconcile loop. Each tick it
reads desired state (qualifying issues + their status labels) and
observed state (yak runs on disk, PRs on GitHub), computes the
difference, and applies one step toward closing it. Wake, diff, act,
exit. No daemon; nothing runs between ticks.

Durable state lives in exactly two places, neither of them the harness:

- **GitHub** — issue labels and hidden marker comments.
- **yak's `.runs/` journal** — authoritative for run status.

The harness keeps only non-load-bearing operational scratch in
`.harness/` (a lock file, per-run pid files). Any of it can be deleted
between ticks with no loss of correctness; a full rescan always
reconstructs the truth.

---

## 3. Requirements (box preconditions)

The harness assumes the following, and does **not** manage or install
any of it. `yak-harness doctor` checks 1–5 on demand.

1. **`gh` CLI installed and authenticated**, with `repo` scope and
   access to the target repo. The harness shells out to `gh` for every
   GitHub operation and never handles a token itself.
2. **`yak` on `PATH`** (e.g. `npm i -g @lchase/yak`), invocable as
   `yak`. Used as a subprocess: `yak run`, `yak resume`, `yak pending`.
3. **The target repo checked out** at `yakRepoPath` (config), on its
   default branch. The harness never clones or pulls it — keeping that
   checkout current is the operator's job (or a separate cron).
4. **Node 22+** to run `yak-harness` itself.
5. **Write access** to `<yakRepoPath>/.runs/` and
   `<yakRepoPath>/.harness/` as the cron user.
6. **Persistent filesystem.** `.runs/` journals and `.harness/` pid
   files must survive between ticks and across reboots. Not ephemeral
   CI.

---

## 4. Configuration (ticket 06)

One plain-JSON file, path passed explicitly as `--config <path>` to
every `yak-harness` invocation. Parsed with a zod schema at startup,
before any observation; a violation prints the zod error and exits
non-zero.

```jsonc
{
  "repo": "owner/name",                // required
  "yakRepoPath": "/srv/yak",            // required — where `yak run` is invoked
  "runsDir": "/srv/yak/.runs",          // optional, default `<yakRepoPath>/.runs`
  "qualifyingLabel": "yak",             // default "yak"
  "stalledAfterMinutes": 45,            // required — no safe default
  "maxConcurrent": 2,                   // default 2
  "workflow": "fix-defect",             // default "fix-defect"
  "inputTemplate": "issueRef={{repo}}#{{number}}"
                                        // {{repo}} {{number}} {{title}} substitution
}
```

- **`stalledAfterMinutes`** has no default — a healthy agent step
  legitimately runs a long time and the right threshold depends
  entirely on the workflow. The operator must set it.
- **`maxConcurrent`** — how many `yak run`s may be in flight at once.
  One launch per tick regardless (§6.2), so an idle harness ramps to
  this cap over several ticks.
- **`workflow` + `inputTemplate`** — one workflow per deployment.
  Label-routing to multiple workflows is out of scope for v1.

**Locked constants** (a `const` in source, not config; each carries a
`// config candidate if a real need appears` comment):

| constant | value | origin |
|---|---|---|
| gate re-prompt limit | `1` | ticket 04 |
| max run attempts | `2` | ticket 05 |
| accepted `author_association` | `OWNER`, `MEMBER`, `COLLABORATOR` | ticket 04 |
| `yak:` status prefix + the six status names | fixed | ticket 03 |
| `.harness/` location | `<yakRepoPath>/.harness` | — |
| all marker-comment formats | fixed strings | machine contract |

The **cron interval is not harness config** — it lives only in the
crontab line. The tick is stateless and idempotent and does not need
to know its own cadence.

### Startup checks (fail fast, every invocation)

`--config` zod-parses; then: `yakRepoPath` exists and is a git repo,
`gh auth status` succeeds, `yak --version` runs. Any failure → print
it, exit non-zero, do nothing partial.

---

## 5. Run ↔ issue linkage (ticket 01)

yak generates its own run ids (`engine/run.ts` `generateRunId`:
ISO-time-with-colons-stripped + 4 hex) and there is no `yak run --id`.
No issue ↔ run linkage exists anywhere in yak. The harness owns this
mapping, keeps it **in the tracker only** (no load-bearing local
state), and reconstructs it from scratch every tick.

### 5.1 Capture at launch — snapshot-and-diff `.runs/`

The harness is the sole launcher and performs **one launch per tick**
(§6.2), so a launch is unambiguous:

1. `listdir(runsDir)` → `before` set.
2. Spawn `yak run <workflow> --isolation worktree` **detached** (§5.4),
   with `--input` built from `inputTemplate`.
3. Poll `listdir(runsDir)` until exactly one new directory appears
   (sub-second — yak `mkdir`s the run dir early). `after - before` must
   be exactly one name; that is the run id. Zero or multiple new dirs
   is a harness fault — abort the tick, log, launch nothing.
4. Assert before trusting: read `<runDir>/journal` first event, require
   `t: 'run.started'` with `workflow` matching what was launched and a
   `launched` timestamp within the tick window.

Rejected: parsing the id off `yak run` stdout (only printed at terminal
state — would block the tick until the run finishes).

### 5.2 Durable linkage — one marker comment per launch

Immediately after the id is resolved and before the tick exits, the
harness posts one comment on the originating issue:

```
🐂 yak run started: `2026-09-06T09-12-44Z-a1b2`
<!-- yak-harness run=2026-09-06T09-12-44Z-a1b2 branch=yak/2026-09-06T09-12-44Z-a1b2 launched=2026-09-06T09:12:45Z -->
```

The machine reads only the HTML comment; the prose line is for humans.
This is the **sole** durable linkage. A legitimate re-run after a
failure posts a fresh marker — **last marker wins**, earlier markers
are kept as history (and their count is the attempt counter, §9.2).

### 5.3 Reconstruction each tick — one scan, both directions

1. List issues carrying **any** harness-relevant label — the
   `qualifyingLabel` *or* any `yak:<status>` label. Widening past the
   qualifying filter is required: an in-progress issue whose label has
   moved off the filter must still be scanned.
2. For each, read its comments; extract every marker's `run=`. The
   **last** marker comment is the issue's current run.
3. Build `runId → issueNumber` and its inverse from that single scan.

Reverse lookup (a suspended run id from `yak pending` → its issue) uses
the inverted dict. A run id with no entry is an orphan or stale case
(§5.5).

### 5.4 Detached launch + pid file

A tick cannot block for a multi-hour AI run, so `yak run` is spawned
**detached** and the tick exits while it runs. On successful launch the
harness writes `.harness/runs/<run-id>.json = { pid, issue, launchedAt }`
— the detached child's pid, used later to kill a stalled run (§9.3).
This file is operational scratch: a stale one makes the kill a no-op,
and the full scan remains authoritative for everything else.

(This subsumes an earlier `.harness/launching` breadcrumb from
ticket 02: the same file is written *before* the spawn as a
launch-in-progress marker, then rewritten with the pid and kept.)

### 5.5 Orphans and stale markers

- **Orphan** — a `.runs/` dir or `yak pending` entry with no marker on
  any scanned issue (crash between spawn and marker post; or a human
  deleted the marker / unqualified the issue).
  - Run alive or suspended: log loudly, count it against
    `maxConcurrent`, launch nothing new, **never guess an issue**. One
    live orphan that cannot be recovered from the pre-spawn
    `.harness/runs/<id>.json` wedges new launches until a human clears
    it — strictly safer than mislinking a gate comment.
  - Run already `ok`/`failed`: nothing to bridge. Log once, continue.
- **Stale marker** — an issue's last marker points at a run id with no
  `.runs/` dir (box replaced, `.runs/` pruned).
  - Treat the issue as having no active run.
  - If its label says in-progress, transition to `yak:failed` (§8).
  - **Never auto-relaunch off a marker alone.**

---

## 6. The tick (ticket 02)

### 6.1 Shape — `observe → plan → apply`

One reconcile function per tick:

```
observe() -> Observation          // all reads
plan(observation) -> Action[]     // PURE — no I/O, no mocks needed to test
apply(actions)                    // all GitHub / yak side effects
```

`plan` is a pure function of the `Observation`. This is the yak
convention (`every engine behavior gets a test using the mock adapter`)
applied here: the entire decision layer is data-in / data-out and
testable with no network and no filesystem.

### 6.2 `observe` — the single read phase

Returns an `Observation`:

1. **`issues[]`** — one `gh` query for issues carrying any
   harness-relevant label (§5.3). Parse marker comments into
   `runId ↔ issueNumber` both ways.
2. **`pending[]`** — parsed `yak pending`: run id, open step ids,
   per-step `kind` + first line of `.rendered`.
3. **`runs[]`** — one `runsDir` listing; classify each by journal tail:
   - `alive` — last event is not `run.finished`
   - `suspended` — last event `run.finished` + `status: 'suspended'`
   - `ok` / `failed` — last event `run.finished` with that status
   - `stalled` — `alive` **and** the journal's last-event mtime is
     older than `stalledAfterMinutes`. Pure function of the journal;
     no harness clock or counter.
4. **Derived** — `orphans[]`, `stale[]` (§5.5); PR state for `ok` runs
   (§8.3).

The launch-time `.runs/` before-snapshot (§5.1) is taken inside
`apply`, immediately before the spawn — **not** in `observe` — or a run
finishing mid-tick pollutes the diff.

### 6.3 `plan` — action set and precedence

| # | Action | Trigger |
|---|--------|---------|
| A | Post gate comment | suspended run, no gate marker for this (run, step) |
| B | Write answer + `yak resume` | valid parsed reply (§7), no answered-marker yet |
| C | Relabel finished run | current labels ≠ target for the observed run class |
| D | Launch new backlog run | qualifying issue, no marker comment, cap has room |
| E | Flag orphan / stale | §5.5 cases |

`in_flight_count` = runs classified `alive` or `suspended` (a suspended
run still owns its slot — unfinished workflow).

Only **D** consumes the cap. A/B/C/E are bookkeeping on runs that
already exist and run **every tick regardless of in-flight count**.

Precedence within a tick:

1. **E first.** Any *live* orphan → plan E only, skip D this tick.
2. **B** — resuming may free a cap slot the same tick.
3. **A** — surface new gates.
4. **C** — clean up terminals.
5. **D** — `in_flight_count < maxConcurrent`, no launch already
   planned this tick, issue has no marker comment, no in-progress
   `.harness/runs/*` launch breadcrumb. **At most one launch per
   tick** even when several slots are free — this keeps §5.1's
   snapshot-diff unambiguous; idle ramps to full cap over a few ticks.

Label transitions (the `(labelState, runClass) -> (targetLabelState,
actionKind)` lookups) come from §8's pure transition table, which
`plan` calls as a function. No label strings appear in the tick code
itself.

### 6.4 `apply` — idempotency predicate per action

Every action's guard is evaluated in `plan` from the `Observation`;
nothing fires without its guard clear. A tick can die at any point and
every action must be safe to re-attempt.

| Action | Guard |
|---|---|
| A | no comment carrying `<!-- yak-gate run=<id> step=<stepId> ... -->` |
| B | reply present, parses valid (§7), no `<!-- yak-answered run=<id> step=<stepId> -->` marker, **and** run still observed `suspended`. `apply`: `writeAnswer` (overwrite-safe) → post answered-marker → `yak resume`. Death mid-sequence → next tick redoes both; both idempotent. |
| C | current labels ≠ target labels (`gh` add/remove is idempotent) |
| D | `in_flight_count < maxConcurrent` **and** issue has no marker comment **and** no launch breadcrumb |
| E | needs-human label / marker not already present |

### 6.5 Quiet vs wedged

A quiet backlog (no qualifying issues, no runs) produces an empty
`Action[]` and the tick exits cheap. A wedged run surfaces as the
`stalled` class (§6.2) and is handled by §9.3 — never by a bare timer
in the tick.

### 6.6 Overlap guard

At startup `yak-harness tick` takes an exclusive lock on
`.harness/tick.lock` (flock-style) and exits 0 immediately if another
tick holds it. A slow tick overlapping the next cron fire is therefore
safe with no operator setup.

---

## 7. Gate bridge (ticket 04, prototype `prototype-04-gate-bridge.md`)

When a run suspends on a `gate`, `pending/<step>.request.json` carries
`rendered` (a freeform prose string the workflow author wrote — the
harness has no semantic understanding of it) and `answerSchema` (a JSON
Schema object — in practice always a flat object of scalar / enum
properties).

### 7.1 Comment format — contract generated from `answerSchema`

The harness does **not** hand-author a contract per gate kind. A
generic renderer walks `answerSchema`'s properties and emits one line
each:

| property type | contract line | accepted input |
|---|---|---|
| `enum` string | `field: a \| b \| c` | any member, case-insensitive, quotes stripped |
| required `string` | `field: <text>` | rest of line (last field may absorb trailing lines) |
| optional `string` | `field: <optional …>` | omit the line to omit the field (never sent as `""`) |
| `boolean` | `field: yes \| no` | yes/y/true, no/n/false (case-insensitive) |
| `number` | `field: <number>` | `Number()`, must be finite |

**Nested objects / arrays in an `answerSchema` are out of scope** — the
harness posts "this gate needs a hand-written answer file", routes the
issue to `yak:failed`, and stops. Spec constraint on yak workflow
authors: **gates meant to be harness-bridged must keep `answerSchema` a
flat object of scalar / enum properties.**

The posted comment:

```
🐂 **yak needs a decision — <stepId>**

<the `rendered` string, verbatim>

---
**To answer, reply to this comment with:**
```
decision: proceed | narrow | abort
notes: <optional free text>
```
Run `<run-id>` · step `<stepId>`

<!-- yak-gate run=<run-id> step=<stepId> schema-sha=<hash> -->
```

### 7.2 Reply parsing (no LLM)

GitHub issue comments are a flat list — no API threading.

- Consider only comments posted **after** the harness's gate comment.
- **Author filter:** `author_association` ∈ {`OWNER`, `MEMBER`,
  `COLLABORATOR`}, read straight off the comments payload (zero extra
  API calls). `CONTRIBUTOR` / `NONE` are ignored.
- The **first** qualifying comment containing ≥1 `field:` line matching
  a schema property is the answer attempt.
- Parse is line-based `key: value`: trim key and value, flexible `:`
  spacing, strip surrounding quotes, enum match case-insensitive.
- Non-matching chatter is ignored — **unless** it contains a `:` and a
  schema field name (a botched attempt), which counts against the
  re-prompt budget.
- After the `<!-- yak-answered ... -->` marker, all further comments on
  that step are ignored.

### 7.3 Malformed / ambiguous / never-reply

Malformed = no matching `field:` line, invalid enum value, duplicate
field, or wrong type. Ambiguous (a field given twice) is treated as
malformed — the harness never picks one.

- **One** re-prompt, as a comment naming exactly what was wrong and
  repeating the required line(s). Marker
  `<!-- yak-gate-reprompt run=<id> step=<stepId> attempt=1 -->`.
- Second bad attempt → stop, transition the issue to `yak:failed`
  (§8), comment that a human must hand-write
  `pending/<stepId>.answer.json` and `yak resume`. No third attempt.
- **Never replies at all → no timeout.** The issue sits in
  `yak:waiting` indefinitely and the run holds its cap slot; that
  visible queue stall *is* the signal. If gate backlog becomes real
  pain the lever is a higher `maxConcurrent`, not a gate timeout —
  auto-failing a gate to reclaim a slot throws away the run's work.

### 7.4 Answer construction + validation

Parser output → validate against `answerSchema` with `ajv` **before**
`writeAnswer`. A validation failure the line-parser missed is handled
exactly like a malformed reply. Belt and braces: yak's own
`completeGate` re-runs `schema.safeParse` on `yak resume`, so a harness
bug that writes a bad answer fails loudly at resume rather than
corrupting the run.

### 7.5 Resume trigger

The same `apply` that parses a valid reply does all three in order:
`writeAnswer(runDir, stepId, answer)` → post the `yak-answered` marker
→ `yak resume <run-id>`. Not deferred to the next tick. Crash between
`writeAnswer` and `yak resume` → next tick sees no `yak-answered`
marker → redoes both (idempotent). Whatever `yak resume` does next
(suspend on the next gate, finish, fail) is just the next tick's normal
observation.

---

## 8. Label lifecycle (ticket 03)

### 8.1 The label set

**One harness-owned, single-valued `yak:<status>` label** is the whole
state machine. The observation must read exactly one `yak:<status>` per
issue; two is a harness fault → flag, act on nothing.

| status | meaning | run class behind it | owner |
|---|---|---|---|
| `yak` only, no `yak:<status>` | qualified, not yet launched | no run | **human** adds `yak` |
| `yak:running` | run launched, working | `alive` | harness |
| `yak:waiting` | suspended on a gate — human reply needed | `suspended` | harness |
| `yak:pr-open` | run finished ok, PR opened | `ok` + PR open | harness |
| `yak:failed` | failed / stalled / orphan / stale — **needs human** | `failed`, `stalled`, orphan, stale | harness |
| `yak:done` | PR merged — terminal, inert | `ok` + PR merged | harness |

Human-owned extras:

- **`yak`** (= `qualifyingLabel`) — the qualifying filter. A human only
  applies it to work they have already scoped (this is the primary
  scope defence; see yak's dark-factory effort). Stays on for the whole
  lifecycle, including `yak:done`, as history.
- **`yak:hold`** — park override. While present the harness skips the
  issue **entirely**: no observation contribution, no gate post, no
  relabel, no resume. It does **not** pause a live `yak run` (the
  harness has no such power) — it only freezes the harness's own
  reactions.

### 8.2 Transition table

`plan` calls this as a pure function
`(currentStatus, runClass) -> (nextStatus, action)`. `∅` = no
`yak:<status>` label. `—` = no change.

| current \ observed | `none` | `alive` | `suspended` | `ok` no PR | `ok`+PR open | `ok`+PR merged | `ok`+PR closed-unmerged | `failed`/`stalled`/orphan/stale |
|---|---|---|---|---|---|---|---|---|
| **`yak`, ∅** | launch → `yak:running` | recover marker → `yak:running` | `yak:waiting` + post gate | `yak:failed` | `yak:pr-open` | `yak:done` | `yak:failed` | `yak:failed` + flag |
| **`yak:running`** | `yak:failed` (stale marker — never auto-relaunch) | — | `yak:waiting` + post gate | `yak:failed` (ok but no PR = workflow bug) | `yak:pr-open` | `yak:done` | `yak:failed` | `yak:failed` + flag |
| **`yak:waiting`** | `yak:failed` | `yak:running` (resumed, working) | — (re-prompt logic is §7.3) | `yak:failed` | `yak:pr-open` | `yak:done` | `yak:failed` | `yak:failed` + flag |
| **`yak:pr-open`** | `yak:failed` | `yak:running` | `yak:waiting` | `yak:failed` | — | `yak:done` | `yak:failed` (human closed PR unmerged) | `yak:failed` |
| **`yak:failed`** | — | — | — | — | — | — | — | — |
| **`yak:done`** | — | — | — | — | — | — | — | — |

Rules the table encodes:

- **`yak:failed` is a trap** — the harness never auto-leaves it. A
  human investigates and either fixes and manually resets the label
  (to `yak` for a clean relaunch, or `yak:running` if the existing run
  is salvageable), or closes the issue.
- **`ok` with no PR** → `yak:failed`. Success exit but `open-pr`
  produced nothing = a workflow bug a human must see.
- **PR closed unmerged** → `yak:failed`. No PR-revision loop (§11).
- **Stale marker while `yak:running`** (observed `none`) →
  `yak:failed`, never a silent relaunch.
- The harness transitions only on evidence from yak's journal /
  on-disk state, never on a timer alone (`stalled` itself is a
  journal-mtime fact, §6.2).

### 8.3 PR state detection

yak's reference `open-pr` is a `command` step: `produces: 'pr-url'`,
`run: 'gh pr create --fill'`. When a run is `ok`, the harness reads the
**`pr-url` artifact** from the run dir (a declared run output — as much
a contract as `pending/`), then `gh pr view <url> --json state,mergedAt`
for open / merged / closed. Fallback if the artifact is missing:
`gh pr list --head yak/<run-id>` (exact branch match — the worktree
branch is deterministic). No dependence on the PR body mentioning the
issue.

### 8.4 Cleanup

`yak:done` costs one relabel, then the issue is inert. The harness
performs **zero destructive cleanup**:

- Does not close issues (a `Closes #N` in the merged PR does that; if
  absent, a human closes it).
- Does not delete the `yak/<run-id>` branch (GitHub's auto-delete
  setting or a human; deleting git refs escapes the harness's remit).
- Does not touch `.runs/` dirs or worktrees — the journal is yak's;
  yak cleans.
- Never deletes or strikes through its marker comments — they are
  permanent history.

---

## 9. Failure and retry (ticket 05)

### 9.1 Auto-retry on `failed`

yak's `StepFailure` is `{ reason, detail, recoverable: boolean }` over
nine reasons. **The `recoverable` flag is yak's own call on whether a
retry could help**; the harness keys off it rather than maintaining its
own reason allowlist.

Retry **iff** `terminalFailure.recoverable === true` **and**
`attemptCount < 2`. Otherwise → `yak:failed` immediately.

- `recoverable: false` (`tool-denied`, `needs-decision`,
  `needs-context`, …) → straight to `yak:failed`.
- A retry is a **fresh `yak run`** (new run id, new marker — last-wins,
  §5.2). Never `yak resume` — a failed run is not suspended.
- Hard cap **2 attempts total** (original + 1 retry). Second failure →
  `yak:failed` regardless of `recoverable`.

### 9.2 Attempt count + back-off

- **Attempt count = the number of `yak-harness run=` marker comments on
  the issue.** No new marker type; the tick already scans every marker.
- **No explicit back-off.** The retry fires on the next tick with a
  free cap slot. The cron interval is the spacing; a `recoverable`
  failure is transient and clears fast.

### 9.3 `stalled` runs — harness kills them

The harness launched `yak run` detached (§5.4) and recorded its pid.
On the `stalled` classification (§6.2): read
`.harness/runs/<run-id>.json`, verify the pid is alive **and is a
`yak` process** (guard against pid reuse — check the process command),
`kill` it, then relabel the issue `yak:failed`.

**`stalled` never retries** — there is no `recoverable` signal (the run
produced no terminal `StepFailure`), and a stall means genuinely
wedged, not transient.

### 9.4 `yak:failed` escalation — one comment

On every transition into `yak:failed`, post **one** comment guarded by
a `<!-- yak-failed run=<id> -->` marker, containing:

- **What broke:** the terminal `StepFailure` `reason` + `detail` (via
  yak's `failedStepsFromJournal` over `.runs/<id>/journal`); or
  `"run stalled — no journal activity for <duration>, process killed"`;
  or `"run finished ok but produced no PR"`.
- **What was tried:** `"attempt 2 of 2"` / `"not retried — tool-denied
  is not recoverable"`.
- **What the human does:** inspect `.runs/<run-id>/journal`, then
  either fix and relabel `yak` for a clean relaunch, or close the
  issue.

No `@`-mention in v1.

### 9.5 Interaction with the cap

- A run mid-retry counts as in-flight exactly like any launch.
- Repeated failure eventually frees the slot: attempt 2 fails →
  `yak:failed` → run is terminal (`failed`), no longer counted
  in-flight, slot released next tick.
- A `stalled` run holds its slot only until the tick that kills it.

---

## 10. Deployment (ticket 07)

### 10.1 Repo and coupling

- **New standalone GitHub repo, `yak-harness`.** (Not `yak-factory` —
  that name is reserved for a hypothetical future monorepo sibling.)
- **Fully decoupled from yak.** No `@lchase/yak` dependency. The
  harness re-declares as local zod schemas the three on-disk yak
  shapes it reads — `GatePendingRequest`
  (`pending/<step>.request.json`), the `run.started` / `run.finished`
  journal events, and `StepFailure` `{reason, detail, recoverable}` —
  and parses yak's files at the boundary. yak is a **runtime**
  requirement (the `yak` binary), never a build dependency. The
  re-declared schemas double as boundary validation.
- Toolchain mirrors yak: TypeScript, ESM, Node 22, `tsup` build to
  `dist/`, `vitest`. `bin` entry `yak-harness`. Deps: `zod`, `ajv`.

### 10.2 CLI surface

```
yak-harness tick   --config <path> [--dry-run]   # one reconcile pass
yak-harness doctor --config <path>               # check box preconditions 1–5
```

`--dry-run` runs `observe` + `plan`, prints the planned actions,
applies nothing.

### 10.3 Scheduling

**Plain system `cron`**, one documented crontab line:

```
*/5 * * * * yak-harness tick --config /srv/harness.config.json
```

Overlap is the harness's concern (§6.6), not the operator's. A
`systemd` timer is a documented alternative; no unit files are shipped.

### 10.4 Versioning and release

- **Deploy = `git pull && npm run build`** on the box; the next cron
  tick runs the new `dist/`. No restart (stateless process).
- The repo uses **conventional commits and a maintained CHANGELOG**
  (cheap; makes a later release-please switch trivial), but **no npm
  publish pipeline** in v1.
- npm publish / release-please / trusted publishing (mirroring yak) is
  **deferred** until a second box or external consumer exists.

### 10.5 Logging

- **One self-rotating JSON-lines file, `.harness/tick.log`.** One line
  per tick: timestamp, duration, counts (issues scanned, runs by
  class), every action taken (`launched run X for #12`, `posted gate on
  #7`, `resumed X`, `killed stalled X`, `flagged #9 failed`), and any
  non-fatal errors. The harness rotates it itself at a size cap — no
  `logrotate` dependency.
- **stderr + non-zero exit** for fatal preconditions.
- **Nothing remote** — no metrics endpoint, no dashboard, no alert
  sink. The durable human-facing record is the GitHub issues
  themselves: labels, marker comments, and the `yak:failed`
  explanation comment.

---

## 11. Out of scope

| ruled out | why | returns if |
|---|---|---|
| **Idea-to-qualified-issue refinement** — `/grill-me`-style back-and-forth, Jira/Linear grooming sync, triage meetings. | External. The harness starts at an issue a human has already qualified with the `yak` label. Its only in-workflow human touchpoints are the gate bridge (§7) and the PR — both deliberate and minimised: after a long AI run the PR is otherwise the first checkpoint, with tokens already spent if it went wrong, so `confirm-scope` and the gate bridge catch that *before* the spend. | never — this is the boundary the whole package draws |
| **Multi-provider tracker abstraction** (Jira / Linear / local markdown). | One provider's semantics is not enough signal to guess a good cross-provider seam. | a second real tracker is needed — fresh effort |
| **Patching yak's engine** — including `yak run --id`, a stable run handle, `yak cancel`. | The harness must work against yak as documented. | each is a separate yak ticket, noted below, not depended on |
| **PR-revision loop** (human requests changes on an open PR, harness resumes the implement loop). | Not part of reaching a first PR unattended. | fresh effort |
| **Refactoring the yak repo into packages.** | A redraw of yak's architecture with its own tradeoffs; the harness consumes yak through the CLI + on-disk contract regardless of packaging. Building `yak-harness` standalone first gives that later effort a concrete external consumer to design against. | its own wayfinder effort if a monorepo is on the table |
| **Aggregate observability** — dashboards, cross-run metrics, an alert sink. | The GitHub issues are the record; `.harness/tick.log` is for debugging the harness. | fresh effort |
| **Label-routing to multiple workflows** (`yak:bug` → `fix-defect`, …). | One workflow per deployment covers v1. | a future ticket |

---

## 12. Candidate yak changes (noted, not depended on)

Collected from the tickets. Each would simplify the harness; none is a
prerequisite. All three filed against yak proper 2026-09-06:

- **`yak run --tag <string>`** ([lchase/yak#22](https://github.com/lchase/yak/issues/22))
  — a caller-supplied correlation tag, stored in the `run.started`
  journal event and echoed by `yak pending`. Collapses §5.1 + §5.2 +
  §5.5 into a direct lookup: the harness passes the issue number as the
  tag and reads it straight back.
- **`yak run` prints the run id to stderr at launch**
  ([lchase/yak#23](https://github.com/lchase/yak/issues/23)) — not only
  at terminal state. Makes §5.1 capture exact instead of diff-based.
- **`yak cancel <run-id>`** ([lchase/yak#24](https://github.com/lchase/yak/issues/24))
  — clean engine-side termination of a live run (SIGTERM the process
  tree, journal a terminal `run.finished{status:'failed',
  reason:'cancelled'}`, release the worktree lock). Removes the
  harness's need to track pids and `kill(2)` yak's process directly
  (§9.3).

---

## 13. Suggested implementation order

1. Config schema + `doctor` + the three re-declared yak on-disk zod
   schemas (§4, §10.1).
2. `observe` — the read phase, fully (§6.2). Test against fixture
   `.runs/` trees and canned `gh` JSON.
3. `plan` + the §8.2 transition table — pure, exhaustively unit-tested.
4. `apply` for C and D only (relabel + launch) — end-to-end a backlog
   issue to `yak:pr-open` against a real local yak.
5. `apply` for E (orphan/stale) and §9 (retry, stalled kill).
6. The gate bridge (§7) — A and B. The prototype
   (`prototype-04-gate-bridge.md`) is the acceptance reference.
7. `tick.log`, `--dry-run`, the lock file, packaging.
