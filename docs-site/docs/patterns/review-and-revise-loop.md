---
sidebar_position: 1
title: Review-and-revise loop
---

# Pattern: review-and-revise loop

:::caution Spends real API budget
Like the tutorial, this runs against the real `claude-code` adapter —
two real model calls per round, up to `maxIterations` rounds. Assumes
you've already read the [quickstart](../quickstart) and
[tutorial](../tutorial).
:::

A `loop` step bounds iteration with `maxIterations` and, optionally, a
`noProgress` check — a signal that must keep improving or the loop
suspends rather than spinning forever. This pattern uses both: an agent
implements something, a *second* agent reviews it, and the loop repeats
until the reviewer approves.

## The target: `fixtures/loop-demo`

A single unimplemented function with a tricky spec:

```ts title="fixtures/loop-demo/src/mergeIntervals.ts"
export function mergeIntervals(intervals: Interval[]): Interval[] {
  throw new Error('not implemented')
}
```

Merge overlapping `[start, end]` intervals — including ones that merely
*touch* at an endpoint (`[1, 3]` and `[3, 6]` count as overlapping), and
the input may be unsorted. Seven test cases in
`fixtures/loop-demo/test/mergeIntervals.test.ts` pin down the edge
cases.

## The workflow

```yaml title="fixtures/loop-demo/workflow.yaml"
name: loop-review-revise
version: "1"
steps:
  - id: fix-until-approved
    loop:
      until: "review.approved == true"
      budget:
        maxIterations: 5
        noProgress:
          signal: "testResult.numFailedTests"
          rounds: 2
      body:
        - id: prep-feedback
          needs: [review]
          transform: { fn: prepFeedback }
          produces: priorFeedback

        - id: implement
          needs: [priorFeedback]
          agent:
            prompt: { file: "fixtures/loop-demo/prompts/implement.md" }
            schema:
              inline:
                type: object
                properties:
                  summary: { type: string }
                required: [summary]
            tools: [Read, Edit]
          produces: implementResult

        - id: test
          needs: [implementResult]
          command:
            run: "npx vitest run --reporter=json --root fixtures/loop-demo"
            capture: [stdout, exitCode]
            failOn: never
          produces: testRaw

        - id: parse-test
          needs: [testRaw]
          transform: { fn: parseTestResult }
          produces: testResult

        - id: review
          needs: [testResult]
          agent:
            prompt: { file: "fixtures/loop-demo/prompts/review.md" }
            schema:
              inline:
                type: object
                properties:
                  approved: { type: boolean }
                  feedback: { type: string }
                required: [approved, feedback]
            tools: [Read]
          produces: review
```

Five body steps, run in order, every round: prep the previous round's
feedback into a prompt-friendly string, implement (with `Edit` access),
run the real test suite, parse its JSON output into a number, and have
a *second*, read-only agent review the result. `until` checks the
reviewer's verdict; `noProgress`'s signal is the failing-test count —
if it doesn't improve for two consecutive rounds, the loop suspends
instead of grinding forever.

`prep-feedback`'s `needs: [review]` looks backwards — `review` is
produced by the *last* step in this same body. That's not a cycle: a
loop body's `needs` can point at a step later in its own body, and at
runtime it resolves to *last round's* value (`undefined` on round one).
Reading that possibly-undefined value has to happen in a `transform`
function, not a `{{ }}` prompt placeholder — a placeholder throws on
`undefined`, a plain TypeScript function just checks for it. `fn:
prepFeedback` resolves against a fixed path, `.yak/transforms.ts`
relative to the run's `cwd` — see
[standalone transform](./standalone-transform#why-transform-is-its-own-step-kind)
for that mechanism in full:

```ts title=".yak/transforms.ts"
export function prepFeedback(inputs: Record<string, unknown>): unknown {
  const review = inputs['review'] as Review | undefined
  return review === undefined ? '(first attempt — no prior feedback yet)' : review.feedback
}
```

## Run it

```bash
npx tsx src/cli/index.ts run fixtures/loop-demo/workflow.yaml
npx tsx src/cli/index.ts status
```

## What actually happened

A real run of this pattern took **two rounds**, not one — and the
reason why is the entire point of having a reviewer instead of just
checking exit codes.

**Round 1**: the implementation passed all 7 tests —
`testResult.1.json` showed `numFailedTests: 0`. A test-status check
alone would have called that done. The reviewer didn't:

```json title="review.1.json"
{
  "approved": false,
  "feedback": "Tests pass, algorithm logic correct (sort, `<=` for touching endpoints, chain merge all fine). But bug: mutates caller's input array.\n\n`sorted = [...intervals]` only shallow-copies outer array — inner tuples still same references as `intervals` elements. `result` starts with `sorted[0]`, same reference as `intervals[k]`. Later `last[1] = Math.max(...)` mutates that shared tuple in place — caller's original `intervals` array gets silently modified.\n\nFix: push a copy, not the reference."
}
```

A real bug the test suite never checked for — none of the 7 tests
inspect whether the *input* array got mutated, only the return value.

**Round 2**: `implement` got that exact feedback via `priorFeedback`,
made the one-line fix it described, and the reviewer approved:

```json title="review.2.json"
{
  "approved": true,
  "feedback": "Logic correct: sort by start, <= merges touching endpoints, Math.max handles nested intervals. Input not mutated (spread + new tuples). Clean, matches all 7 cases."
}
```

`noProgress`'s signal (failing-test count) was `0` on both rounds here
— it never got the chance to matter, because the reviewer's judgment
caught something the test count couldn't. That's what a second agent
buys you over a bare `test → loop-if-red` shape: it can reject work a
test suite calls green.
