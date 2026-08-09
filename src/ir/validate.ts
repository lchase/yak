import { buildProducerMap, dependenciesOf } from './graph.js'
import type { ArtifactName, Expr, Step, StepId, Workflow } from './types.js'

export class WorkflowValidationError extends Error {}

const KNOWN_KINDS = new Set(['agent', 'command', 'transform', 'gate', 'map', 'loop'])

export function validateWorkflow(workflow: Workflow): void {
  checkKnownKinds(workflow.steps)
  checkDuplicateIds(workflow.steps)
  const producerOf = buildProducerMap(workflow.steps)
  checkNeedsSatisfied(workflow.steps, producerOf)
  checkNoCycles(workflow.steps, producerOf)
  checkExitCodeReads(workflow.steps, producerOf)
}

function checkKnownKinds(steps: Step[]): void {
  for (const step of steps) {
    if (!KNOWN_KINDS.has(step.kind)) {
      throw new WorkflowValidationError(`step "${step.id}": unknown step kind "${step.kind}"`)
    }
  }
}

function checkDuplicateIds(steps: Step[]): void {
  const seen = new Set<StepId>()
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new WorkflowValidationError(`duplicate step id "${step.id}"`)
    }
    seen.add(step.id)
  }
}

function checkNeedsSatisfied(steps: Step[], producerOf: Map<ArtifactName, StepId>): void {
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      if (!producerOf.has(need)) {
        throw new WorkflowValidationError(
          `step "${step.id}": needs artifact "${need}" but no step produces it`,
        )
      }
    }
  }
}

function checkNoCycles(steps: Step[], producerOf: Map<ArtifactName, StepId>): void {
  const stepsById = new Map(steps.map((s) => [s.id, s]))
  const state = new Map<StepId, 'visiting' | 'done'>()

  function visit(step: Step, path: StepId[]): void {
    const mark = state.get(step.id)
    if (mark === 'done') return
    if (mark === 'visiting') {
      const cycle = [...path, step.id].join(' -> ')
      throw new WorkflowValidationError(`cycle detected: ${cycle}`)
    }
    state.set(step.id, 'visiting')
    for (const depId of dependenciesOf(step, producerOf)) {
      const dep = stepsById.get(depId)
      if (dep) visit(dep, [...path, step.id])
    }
    state.set(step.id, 'done')
  }

  for (const step of steps) visit(step, [])
}

/**
 * Spec §9 #6: reading `<artifact>.exitCode` downstream of a command step that
 * still has `failOn: 'exitCode'` is dead code — that step can never survive a
 * non-zero exit, so the read is always `0`. Reject it at load time.
 */
function checkExitCodeReads(steps: Step[], producerOf: Map<ArtifactName, StepId>): void {
  const stepsById = new Map(steps.map((s) => [s.id, s]))

  for (const step of steps) {
    for (const expr of exprsIn(step)) {
      for (const artifactName of exitCodeReferences(expr)) {
        const producerId = producerOf.get(artifactName)
        if (!producerId) continue
        const producer = stepsById.get(producerId)
        if (producer?.kind === 'command' && (producer.failOn ?? 'exitCode') === 'exitCode') {
          throw new WorkflowValidationError(
            `step "${step.id}" reads "${artifactName}.exitCode", but step "${producer.id}" ` +
              `has failOn: 'exitCode' — that step can never produce a non-zero exitCode`,
          )
        }
      }
    }
  }
}

function exprsIn(step: Step): Expr[] {
  const exprs: Expr[] = []
  if (step.kind === 'gate' && step.skipIf) exprs.push(step.skipIf)
  if (step.kind === 'loop') {
    exprs.push(step.until)
    if (step.budget.noProgress) exprs.push(step.budget.noProgress.signal)
    for (const inner of step.body) exprs.push(...exprsIn(inner))
  }
  if (step.kind === 'map') exprs.push(...exprsIn(step.step))
  return exprs
}

function exitCodeReferences(expr: Expr): ArtifactName[] {
  if (typeof expr !== 'string') return []
  const matches = [...expr.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\.exitCode\b/g)]
  return matches.map((m) => m[1]!)
}
