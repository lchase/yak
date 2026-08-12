import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ZodType } from 'zod'
import { writeArtifact } from '../engine/artifacts.js'
import { appendJournalEvent } from '../engine/journal.js'
import { writeGateRequest } from '../engine/suspend.js'
import { renderTemplate } from '../expr/template.js'
import { evalExpr } from '../expr/eval.js'
import type { GateStep } from '../ir/types.js'
import { resolveAgentSchema, toJsonSchema } from './agent.js'

export interface GateRunContext {
  runId: string
  runDir: string
  cwd: string
}

async function renderGate(step: GateStep, inputs: Record<string, unknown>, cwd: string): Promise<string> {
  const text = 'file' in step.render ? await readFile(path.resolve(cwd, step.render.file), 'utf8') : step.render.inline
  return renderTemplate(text, inputs)
}

/** Writes the gate's answer artifact and marks it answered — shared by the
 * `skipIf` path here and by `resume.ts` when a human-answered gate is
 * consumed on `yak resume`. */
export async function completeGate(
  step: GateStep,
  ctx: GateRunContext,
  answer: unknown,
  opts: { skipped: boolean },
): Promise<void> {
  let artifactName: string | undefined
  let artifactHash: string | undefined

  if (step.produces) {
    const schema = await resolveAgentSchema(step.schema, ctx.cwd)
    const written = await writeArtifact(ctx.runDir, step.produces, schema.parse(answer), schema as ZodType)
    artifactName = written.name
    artifactHash = written.hash
    await appendJournalEvent(ctx.runDir, ctx.runId, {
      t: 'artifact.written',
      name: written.name,
      hash: written.hash,
      bytes: written.bytes,
    })
  }

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.completed',
    stepId: step.id,
    ...(artifactName ? { artifact: artifactName, artifactHash } : {}),
    cached: false,
  })

  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'gate.answered',
    stepId: step.id,
    ...(opts.skipped ? { skipped: true } : {}),
  })
}

/**
 * M4 tickets 01/04/05/07/08: a `gate` step never participates in the
 * content cache (no semantic/definitionKey computed — ticket 07), so it's
 * dispatched as its own branch in `scheduler.ts`, the same way `loop` and
 * `map` own their journal lifecycle rather than routing through the
 * generic cache-checked path.
 *
 * `skipIf` true auto-answers from the schema's Zod defaults (ticket 05,
 * validated at load time — every field must default). Otherwise renders
 * the gate and writes a pending request (ticket 08), returning
 * `'suspended'` — the scheduler's existing "let in-flight steps finish,
 * stop scheduling new ones" behavior already opens every eligible gate in
 * a suspending round (ticket 01), with no special-casing needed here.
 */
export async function runGateStep(
  step: GateStep,
  inputs: Record<string, unknown>,
  ctx: GateRunContext,
): Promise<'ok' | 'suspended'> {
  await appendJournalEvent(ctx.runDir, ctx.runId, {
    t: 'step.started',
    stepId: step.id,
    semanticKey: '',
    definitionKey: '',
  })

  const schema = await resolveAgentSchema(step.schema, ctx.cwd)

  const skip = step.skipIf ? Boolean(await evalExpr(step.skipIf, inputs, ctx.cwd)) : false
  if (skip) {
    // Ticket 05: the journal still records both halves — `gate.opened`
    // then `gate.answered{skipped:true}` — so a skipped gate shows the
    // same shape as an answered one in the audit trail, just resolved
    // without a human. No pending request file: there's nothing to answer.
    await appendJournalEvent(ctx.runDir, ctx.runId, { t: 'gate.opened', stepId: step.id, requestPath: '' })
    await completeGate(step, ctx, schema.parse({}), { skipped: true })
    return 'ok'
  }

  const rendered = await renderGate(step, inputs, ctx.cwd)
  // Flat/inline, not the $ref+definitions form `agent.ts` uses for the
  // adapter's structured-output schema — ticket 04's `--interactive`
  // renderer (and any other pending-request reader) expects a bare
  // object schema with `properties`/`required` at the top level.
  const answerSchema = toJsonSchema(schema)
  await writeGateRequest(ctx.runDir, ctx.runId, step, rendered, answerSchema)
  return 'suspended'
}
