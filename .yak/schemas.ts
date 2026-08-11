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
