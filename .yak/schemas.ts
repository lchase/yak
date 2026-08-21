import { z } from 'zod'

// M1 acceptance workflow (test/workflows/agent-fixture-workflow.yaml).
export const TriageSchema = z.object({
  summary: z.string(),
  confidence: z.number(),
})

export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()),
})

// M4 gate-step fixtures (test/workflows/gate-*.yaml).
export const ApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().optional(),
})

// Every field defaults, so `skipIf` can synthesize an answer (ticket 05).
export const AutoApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']).default('approve'),
})

// yak cookbook pattern: review-and-revise loop
// (fixtures/loop-demo/workflow.yaml).
export const ImplementSchema = z.object({
  summary: z.string(),
})

export const ReviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
})

// yak cookbook pattern: loop onExhausted fail/continue
// (fixtures/loop-on-exhausted/workflow-*.yaml).
export const DraftSchema = z.object({
  sentence: z.string(),
})

// yak cookbook pattern: standalone transform
// (fixtures/standalone-transform/workflow.yaml).
export const TodoExtractSchema = z.object({
  todos: z.array(
    z.object({
      task: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
})
