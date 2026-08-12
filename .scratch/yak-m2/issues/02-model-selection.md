# 02 — model selection mapping

Type: research
Status: open
Blocked by: none

## Question

`AgentStep.model?: string` in the IR (spec §3.2: `model: 'default'`, "or
override per step") needs to become an actual Claude Agent SDK model
identifier.

- What does the SDK's `query()` accept for `model` — exact option name,
  and what model-id strings are valid (e.g. `claude-sonnet-5`,
  `claude-opus-5`, aliases like `'default'`)?
- Does the SDK itself understand `'default'`, or does yak need its own
  mapping table (`'default'` → some specific model id) living somewhere
  in `.yak/` or `src/adapters/claude-code.ts`?
- Is model selection static per step (as the IR implies) or does the SDK
  support/require anything else (e.g. fallback models, per-call override)
  that the adapter needs to account for?

Deliverable: the exact SDK option name and valid model-id strings/aliases,
plus a recommendation for whether yak needs its own `'default'` mapping
table.

Context: findings at .scratch/yak-m2/research/02-model-selection-findings.md on branch research/yak-m2-model-selection
