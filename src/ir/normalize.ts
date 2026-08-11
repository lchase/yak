import { z } from 'zod'
import type { AgentStep, CommandStep, Step, TransformStep, Workflow } from './types.js'

const rawCommandSchema = z.object({
  run: z.string(),
  cwd: z.string().optional(),
  failOn: z.enum(['exitCode', 'never']).optional(),
  capture: z.array(z.enum(['stdout', 'stderr', 'exitCode'])).optional(),
})

const rawTransformSchema = z.object({
  fn: z.string(),
})

const rawAgentContextSchema = z.union([
  z.literal('fresh'),
  z.object({ inherit: z.array(z.string()) }),
  z.object({ session: z.string() }),
])

const rawAgentSchema = z.object({
  prompt: z.union([z.object({ file: z.string() }), z.object({ inline: z.string() })]),
  schema: z.string().optional(),
  context: rawAgentContextSchema.optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  repairAttempts: z.number().optional(),
})

const rawStepSchema = z.object({
  id: z.string(),
  needs: z.array(z.string()).optional(),
  produces: z.string().optional(),
  cache: z.enum(['strict', 'loose']).optional(),
  command: rawCommandSchema.optional(),
  transform: rawTransformSchema.optional(),
  agent: rawAgentSchema.optional(),
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

  if (raw.agent) {
    const step: AgentStep = {
      id: raw.id,
      needs: raw.needs ?? [],
      cache: raw.cache ?? 'strict',
      kind: 'agent',
      prompt: raw.agent.prompt,
      ...(raw.agent.schema !== undefined ? { schema: raw.agent.schema } : {}),
      ...(raw.agent.context !== undefined ? { context: raw.agent.context } : {}),
      ...(raw.agent.tools !== undefined ? { tools: raw.agent.tools } : {}),
      ...(raw.agent.model !== undefined ? { model: raw.agent.model } : {}),
      ...(raw.agent.repairAttempts !== undefined ? { repairAttempts: raw.agent.repairAttempts } : {}),
      ...(raw.produces !== undefined ? { produces: raw.produces } : {}),
    }
    return step
  }

  throw new Error(`step "${raw.id}": only "command", "transform", and "agent" steps are supported in M1`)
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
