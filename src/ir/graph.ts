import type { ArtifactName, Step, StepId } from './types.js'

export function buildProducerMap(steps: Step[]): Map<ArtifactName, StepId> {
  const producerOf = new Map<ArtifactName, StepId>()
  for (const step of steps) {
    if (step.produces) producerOf.set(step.produces, step.id)
  }
  return producerOf
}

export function dependenciesOf(step: Step, producerOf: Map<ArtifactName, StepId>): StepId[] {
  return (step.needs ?? [])
    .map((need) => producerOf.get(need))
    .filter((id): id is StepId => id !== undefined)
}
