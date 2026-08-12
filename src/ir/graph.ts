import type { AgentStep, ArtifactName, Step, StepId } from './types.js'

export function buildProducerMap(steps: Step[]): Map<ArtifactName, StepId> {
  const producerOf = new Map<ArtifactName, StepId>()
  for (const step of steps) {
    if (step.produces) producerOf.set(step.produces, step.id)
  }
  return producerOf
}

/** The artifact names an agent step's prompt may reference: `needs` plus
 * whatever `context: { inherit }` widens the inputs with (§3.4). */
export function agentInputNames(step: AgentStep): ArtifactName[] {
  const names = new Set(step.needs ?? [])
  if (typeof step.context === 'object' && 'inherit' in step.context) {
    for (const name of step.context.inherit) names.add(name)
  }
  return [...names]
}

/** A step's full artifact input set — `needs`, widened by `context.inherit`
 * for an agent step. This is what both graph edges and cache keys must be
 * computed from: an inherited artifact is a real input, not just prose. */
export function inputNamesOf(step: Step): ArtifactName[] {
  return step.kind === 'agent' ? agentInputNames(step) : (step.needs ?? [])
}

export function dependenciesOf(step: Step, producerOf: Map<ArtifactName, StepId>): StepId[] {
  return inputNamesOf(step)
    .map((need) => producerOf.get(need))
    .filter((id): id is StepId => id !== undefined)
}

/** Every step reachable from `steps`, including a `loop`'s `body` steps and
 * a `map`'s inner `step` — used by the load-time checks that must see into
 * nested steps (duplicate ids, known kinds, agent tool/schema/prompt
 * validity), as opposed to the top-level scheduler, which treats a `loop`
 * or `map` as one opaque node and never dispatches its nested steps itself. */
export function flattenSteps(steps: Step[]): Step[] {
  const result: Step[] = []
  for (const step of steps) {
    result.push(step)
    if (step.kind === 'loop') result.push(...flattenSteps(step.body))
    if (step.kind === 'map') result.push(...flattenSteps([step.step]))
  }
  return result
}
