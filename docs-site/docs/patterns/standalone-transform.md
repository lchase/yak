---
sidebar_position: 7
title: Standalone transform
---

# Pattern: standalone transform

:::caution Spends real API budget
Like the tutorial, this runs against the real `claude-code` adapter —
one real model call for `extract`; `summarize-todos` costs nothing at
all. Assumes you've already read the [quickstart](../quickstart) and
[tutorial](../tutorial).
:::

Every pattern on this site already uses a `transform` step somewhere —
`prepFeedback` in the review-and-revise loop, `parseTestResult` there
too, `batchIssues`/`batchChecks` sourcing a `map`'s list. None of them
is really *about* `transform`, though; it's always incidental plumbing
around the pattern's real subject. This page is the one that's about it.

## Why `transform` is its own step kind

A `transform` is a named export in `.yak/transforms.ts` — a plain
TypeScript function, `(inputs) => unknown`, resolved by dynamic
`import()` the same way `.yak/schemas.ts` and `.yak/predicates.ts` are.
No model call, no subprocess, no network — just data reshaping between
two steps that do need one of those things.

The alternative isn't hypothetical; it's the two things people actually
reach for:

- **An `agent` step instead** — technically capable of the same
  reshaping (a model can count and group things), but it costs a real
  call and a real token budget for work with a known-correct, boring
  answer. Counting items by priority doesn't need judgment.
- **A `command` step running a script instead** — works, but loses the
  named-export/type-safety convention every other resolver in this repo
  shares (`resolveTransformFn` in `src/steps/transform.ts` is the same
  dynamic-`import()`-of-a-named-export shape `resolveSchemaSpec`'s
  named-ref branch uses for `.yak/schemas.ts`), and the result comes
  back as a shell process's stdout to re-parse rather than a function's
  typed return value.

## The workflow

```yaml title="fixtures/standalone-transform/workflow.yaml"
name: standalone-transform
version: "1"
steps:
  - id: extract
    agent:
      prompt:
        inline: >
          Extract every task from this text as a JSON array of
          {task, priority}, priority one of high/medium/low: "Fix the
          login bug, it's urgent. Update the docs. Refactor the cache
          layer, low priority. Ship the release, high priority."
      schema: TodoExtractSchema
    produces: extracted

  - id: summarize-todos
    needs: [extracted]
    transform: { fn: summarizeTodos }
    produces: todoSummary
```

`extract` is the step that actually needs a model — turning loose prose
into structured `{task, priority}` records takes real language
understanding. `summarize-todos` doesn't:

```ts title=".yak/transforms.ts"
export function summarizeTodos(inputs: Record<string, unknown>): unknown {
  const { todos } = inputs['extracted'] as TodoExtract
  const counts = { high: 0, medium: 0, low: 0 }
  for (const todo of todos) counts[todo.priority] += 1
  return { total: todos.length, byPriority: counts }
}
```

## Run it

```bash
npx tsx src/cli/index.ts run fixtures/standalone-transform/workflow.yaml --adapter claude-code
```

## What actually happened

`extract` did real, genuinely fuzzy work — the source text only states
priority explicitly for 3 of the 4 tasks ("Update the docs" has none),
and the model had to infer one:

```json title="extracted.json"
{
  "todos": [
    { "task": "Fix the login bug", "priority": "high" },
    { "task": "Update the docs", "priority": "low" },
    { "task": "Refactor the cache layer", "priority": "low" },
    { "task": "Ship the release", "priority": "high" }
  ]
}
```

`summarize-todos` did the opposite: mechanical, exact, and — the whole
point — free. Its journal entry has no `budget.consumed` event at all,
unlike every `agent` step everywhere else on this site:

```json title="journal.jsonl (tail)"
{"t":"step.started","stepId":"summarize-todos"}
{"t":"artifact.written","name":"todoSummary","hash":"..."}
{"t":"step.completed","stepId":"summarize-todos","artifact":"todoSummary","artifactHash":"..."}
{"t":"run.finished","status":"ok"}
```

```json title="todoSummary.json"
{ "total": 4, "byPriority": { "high": 2, "medium": 0, "low": 2 } }
```

Re-run this workflow with a different model, a different phrasing of
the same text, or a different day entirely, and `extracted.json` might
come back slightly different — same categories, maybe a different call
on the ambiguous item. `todoSummary.json` will always be an exact,
reproducible function of whatever `extracted.json` actually says. That
split — fuzzy where fuzziness is the point, exact everywhere else — is
what a `transform` step buys a workflow.
