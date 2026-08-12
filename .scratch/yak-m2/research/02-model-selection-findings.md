# Research: Claude Agent SDK model selection (for yak M2)

Source ticket: `.scratch/yak-m2/issues/02-model-selection.md`

## 1. Exact `query()` option name for selecting a model

`model` (type `string`), set inside the `options` object passed to `query()`.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Hello",
  options: {
    model: "claude-opus-4-6", // or an alias like "sonnet", or "default"
  },
});
```

For streaming-input sessions there is also a mid-session setter, `q.setModel(modelString)`, which
accepts the same value space as the `model` option (plus `undefined`/`"default"` to reset to the
session default).

There is also a separate `fallbackModel` option on `Options` — a model to fall back to if the
primary model's request fails (overloaded/unavailable/non-retryable server error). This is
distinct from the `model` option itself; see §4 below.

**Sources:**
- Claude Agent SDK TypeScript docs, `query()` Options reference, fetched via WebFetch from
  `https://code.claude.com/docs/en/agent-sdk/typescript` (accessed 2026-08-10; Claude Code docs
  site, "Options" table entry for `model` and `fallbackModel`, and the "Query object" section
  describing `setModel()`).

## 2. Valid model-id strings/aliases

The SDK's `model` option does not define its own closed enum — it accepts either a **model
alias** or a **model name** (full model ID, or a provider-specific ID for non-Anthropic-API
backends). This is documented on the "Model configuration" page
(`https://code.claude.com/docs/en/model-config`), which the Agent SDK page explicitly links to
for "accepted values and provider-specific IDs."

### Model aliases (Claude Code / Agent SDK, as of docs accessed 2026-08-10)

| Alias | Behavior |
|---|---|
| `default` | Clears any override; resolves to the recommended model for the account type, or an org-configured default. **Documented as "not itself a model alias"** — it's a special sentinel value, listed separately from the alias table. |
| `best` | Fable 5 where available, else the latest Opus model |
| `fable` | Claude Fable 5 |
| `sonnet` | Latest Sonnet model |
| `opus` | Latest Opus model |
| `haiku` | Fast/efficient Haiku model |
| `sonnet[1m]` | Sonnet with 1M-token context |
| `opus[1m]` | Opus with 1M-token context |
| `opusplan` | Special mode: `opus` during plan mode, `sonnet` during execution |

Aliases resolve to different concrete models depending on provider (Anthropic API vs. Claude
Platform on AWS vs. Bedrock/Vertex vs. Microsoft Foundry) and change over time as new models
ship. As of the fetched docs: on the Anthropic API, `opus` → Opus 5, `sonnet` → Sonnet 5.

### Full model IDs

To pin an exact, non-drifting model, use the full model ID string, e.g. `claude-opus-5`,
`claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-4-6`, etc. — the same IDs used by the plain
Claude API (`@anthropic-ai/sdk`). The docs give `claude-opus-5` as the canonical example.

Confirming the ticket's specific question: **`claude-sonnet-5` and `claude-opus-5` are real,
current model ids** per the docs fetched today (2026-08-10) — they are not stale/hallucinated.
The docs also reference a Haiku 4.5 tier (`claude-haiku-4-5`), consistent with what yak's team
described as "Haiku 4.5." (No literal "Claude 5 family" branding term appears in the docs; the
docs simply list Opus 5 / Sonnet 5 / Haiku 4.5 as the current model generation, which matches
what yak's team described.)

### Runtime recognition/validation (Anthropic-API backend only)

On the Anthropic API (not Bedrock/Vertex/Foundry, which pass model strings through unchecked),
Claude Code validates a model string passed via SDK `setModel()`/similar mechanisms against: a
known alias, an entry from the `/model` picker, any string starting with `claude-`, or a custom
model configured via `modelOverrides`/custom model options. An unrecognized string is rejected
with `Model "<name>" is not a recognized model id.` rather than silently accepted and failing
later. The docs are explicit about this for `/model`-style switches; they're less explicit about
whether the *startup* `options.model` value on `query()` gets identical validation, but
functionally an invalid full ID still surfaces as a request-time error either way.

**Sources:**
- `https://code.claude.com/docs/en/model-config` (fetched via WebFetch 2026-08-10), sections
  "Available models," "Model aliases," "Setting your model" (recognition rules paragraph), and
  "`default` model setting."

## 3. Does the SDK understand `'default'`, or does yak need its own mapping table?

**The SDK itself understands `'default'` natively** — yak does *not* need to invent its own
`'default'` → concrete-model-id mapping table to satisfy the SDK. Passing `model: "default"` (or
omitting `model` entirely, which is the documented equivalent at the CLI/session level) is a
first-class, SDK/Claude-Code-recognized value: it "clears any model override and reverts to the
recommended model for your account type, or to the organization default model when an admin has
set one." The docs explicitly call out `default` as a distinguished sentinel ("Special value...
Not itself a model alias"), separate from the alias table.

This directly answers the ticket's core question: **yak can pass `'default'` straight through to
the SDK's `model` option** and let Claude Code/the SDK resolve it, rather than yak owning a
translation table in `src/adapters/claude-code.ts` or `.yak/`.

**However — worth flagging back to the human/grilling step**, two caveats that matter for yak's
determinism-focused engine design (per CLAUDE.md: "cache keys are content hashes," reproducible
builds):

1. **`default` is non-deterministic across time/environment.** What `default` resolves to depends
   on account type, org admin config, and Claude Code version — it can silently change (the docs
   note multiple historical resolution changes, e.g. `default` meant Opus 4.8 before v2.1.219,
   Opus 5 after). For a build-system-like engine where "cache keys are content hashes," resolving
   `model: 'default'` to whatever the ambient environment/account decides is in tension with
   reproducible/resumable runs — two runs of the same DAG at different times, or on different
   accounts, could silently execute on different models. This is a design question for the
   grilling/resolution step, not something this research pass should decide.
   - Bearing on `AgentStep.model?: string`'s optional-yet-still-recorded nature: if yak wants a
     reproducibility guarantee, it may still want to *resolve* `'default'` to a concrete model id
     at plan/journal time and record that concrete id in the journal (so resume replays the same
     model), even though the SDK doesn't strictly require yak to do the resolution itself for the
     SDK call to work.
2. **Validation/behavior differs by backend.** The `default`-recognition and alias-resolution
   behavior described above is for the Anthropic API path. Bedrock/Vertex/Foundry accept
   passthrough provider-specific IDs and do not perform the same alias/`default` resolution or
   validation — relevant only if yak's adapter needs to support non-Anthropic-API backends later.

## 4. Not directly asked, but relevant to the adapter (model selection "static per step" vs. other mechanisms)

- Model selection via `query()`'s `model` option is effectively static for the life of that
  `query()` call/session (set once at construction); changing it mid-session requires
  `setModel()` in streaming-input mode, which is a distinct API from the initial `options.model`.
  yak's IR (`AgentStep.model?: string`, one value per step) maps cleanly onto "construct a fresh
  `query()` call per step with `options.model` set to the step's value" — no per-call override
  mechanism inside a single `query()` invocation beyond `setModel()`.
- `fallbackModel` (also on `Options`) is a separate, adjacent concept — an availability/error
  fallback chain (comma-separated model list in the CLI equivalent), not part of "which model
  runs this step." Worth noting for later milestones (retry/fallback policy) but out of scope for
  this step-to-model mapping question.

**Sources for §4:** same Agent SDK TypeScript docs page as §1, plus `model-config.md` §"Fallback
model chains" (fetched 2026-08-10).
