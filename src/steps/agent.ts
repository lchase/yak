import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZodType, type ZodError } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { AgentAdapter } from '../adapters/types.js'
import { writeRejectedOutput } from '../engine/artifacts.js'
import { appendJournalEvent } from '../engine/journal.js'
import { renderTemplate } from '../expr/template.js'
import type { AgentStep, StepFailure } from '../ir/types.js'

export { agentInputNames } from '../ir/graph.js'

export async function resolveAgentSchema(name: string, cwd: string): Promise<ZodType> {
  const modulePath = path.resolve(cwd, '.yak/schemas.ts')
  const mod: Record<string, unknown> = await import(pathToFileURL(modulePath).href)
  const schema = mod[name]
  if (!(schema instanceof ZodType)) {
    throw new Error(`schema "${name}" not found in .yak/schemas.ts`)
  }
  return schema
}

export function toJsonSchema(schema: ZodType, name: string): object {
  return zodToJsonSchema(schema, name)
}

export async function buildPrompt(step: AgentStep, inputs: Record<string, unknown>, cwd: string): Promise<string> {
  const text =
    'file' in step.prompt ? await readFile(path.resolve(cwd, step.prompt.file), 'utf8') : step.prompt.inline
  return renderTemplate(text, inputs)
}

export interface AgentCallContext {
  runId: string
  runDir: string
  cwd: string
  adapter: AgentAdapter
  sessionId?: string // set when context: { session } resumes a prior step
}

/**
 * One call to the adapter — the unit schema repair (§3.5) retries. Journals
 * `budget.consumed` on every call, including retries, per the M1 map's
 * budget-accounting-scope decision: plumbing now, no enforcement until M3.
 */
export async function callAgentOnce(
  step: AgentStep,
  inputs: Record<string, unknown>,
  ctx: AgentCallContext,
  promptSuffix?: string,
): Promise<{ output: unknown; sessionId: string }> {
  const prompt = (await buildPrompt(step, inputs, ctx.cwd)) + (promptSuffix ?? '')
  const schema = step.schema ? await resolveAgentSchema(step.schema, ctx.cwd) : undefined
  const jsonSchema = schema ? toJsonSchema(schema, step.schema!) : undefined

  const response = await ctx.adapter.run({
    prompt,
    tools: step.tools ?? [],
    cwd: ctx.cwd,
    model: step.model,
    schema: jsonSchema,
    sessionId: ctx.sessionId,
    signal: new AbortController().signal,
  })

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'budget.consumed',
    stepId: step.id,
    tokens: response.tokens.input + response.tokens.output,
  })

  return { output: response.output, sessionId: response.sessionId }
}

export class AgentStepFailedError extends Error {
  readonly failure: StepFailure

  constructor(failure: StepFailure) {
    super(failure.detail)
    this.failure = failure
  }
}

/** One line per issue: `path.to.field: <zod's own message>` — zod's default
 * `invalid_type` message already reads "Expected X, received Y". */
function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
}

function repairSuffix(jsonSchema: object, errorSummary: string): string {
  return (
    `\n\n---\nYour previous output did not match the required schema.\n` +
    `Schema:\n${JSON.stringify(jsonSchema)}\n\nValidation errors:\n${errorSummary}\n\n` +
    `Return output that satisfies the schema.`
  )
}

/**
 * §3.5 schema repair loop. A schema-less step makes a single call and
 * returns its output unvalidated. A schema'd step validates the output;
 * on failure it re-prompts in the same session (original prompt + a fixed
 * validation-error suffix) up to `repairAttempts` (default 2) times. Still
 * failing after that many retries: the raw output is preserved at
 * `artifacts/.rejected/<step>.<n>.txt` and the step fails with
 * `reason: 'schema-invalid'`.
 */
export async function runAgentStep(
  step: AgentStep,
  inputs: Record<string, unknown>,
  ctx: AgentCallContext,
  onSessionId?: (sessionId: string) => void,
): Promise<unknown> {
  const schema = step.schema ? await resolveAgentSchema(step.schema, ctx.cwd) : undefined
  const maxAttempts = (step.repairAttempts ?? 2) + 1

  let sessionId = ctx.sessionId
  let suffix: string | undefined
  let lastOutput: unknown
  let lastErrorSummary = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const call = await callAgentOnce(step, inputs, { ...ctx, sessionId }, suffix)
    sessionId = call.sessionId
    onSessionId?.(sessionId)
    lastOutput = call.output

    if (!schema) return call.output

    const parsed = schema.safeParse(call.output)
    if (parsed.success) return parsed.data

    lastErrorSummary = formatZodError(parsed.error)
    suffix = repairSuffix(toJsonSchema(schema, step.schema!), lastErrorSummary)
  }

  await writeRejectedOutput(ctx.runDir, step.id, maxAttempts, JSON.stringify(lastOutput, null, 2))

  throw new AgentStepFailedError({
    reason: 'schema-invalid',
    detail: lastErrorSummary,
    recoverable: false,
  })
}
