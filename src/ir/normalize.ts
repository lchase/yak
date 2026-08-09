import { z } from 'zod'
import type { CommandStep, Step, TransformStep, Workflow } from './types.js'

const rawCommandSchema = z.object({
  run: z.string(),
  cwd: z.string().optional(),
  failOn: z.enum(['exitCode', 'never']).optional(),
  capture: z.array(z.enum(['stdout', 'stderr', 'exitCode'])).optional(),
})

const rawTransformSchema = z.object({
  fn: z.string(),
})

const rawStepSchema = z.object({
  id: z.string(),
  needs: z.array(z.string()).optional(),
  produces: z.string().optional(),
  cache: z.enum(['strict', 'loose']).optional(),
  command: rawCommandSchema.optional(),
  transform: rawTransformSchema.optional(),
})
type RawStep = z.infer<typeof rawStepSchema>

const rawWorkflowSchema = z.object({
  name: z.string(),
  version: z.string(),
  inputSchema: z.string().optional(),
  steps: z.array(rawStepSchema),
})

function normalizeStep(raw: RawStep): Step {
  if (raw.command) {
    const step: CommandStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'command',
      run: raw.command.run,
      failOn: raw.command.failOn ?? 'exitCode',
      capture: raw.command.capture ?? ['stdout', 'stderr', 'exitCode'],
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
      ...(raw.command.cwd !== undefined ? { cwd: raw.command.cwd } : {}),
    }
    return step
  }

  if (raw.transform) {
    const step: TransformStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'transform',
      fn: raw.transform.fn,
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
    }
    return step
  }

  throw new Error(`step "${raw.id}": only "command" and "transform" steps are supported in M0`)
}

export function normalizeWorkflow(raw: unknown): Workflow {
  const parsed = rawWorkflowSchema.parse(raw)
  return {
    name: parsed.name,
    version: parsed.version,
    ...(parsed.inputSchema !== undefined ? { inputSchema: parsed.inputSchema } : {}),
    steps: parsed.steps.map(normalizeStep),
  }
}
