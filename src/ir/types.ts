export type StepId = string
export type ArtifactName = string
export type JSONSchema = Record<string, unknown>

/** Either a jexl expression string, or a named function in .yak/predicates.ts */
export type Expr = string | { fn: string }

export interface Budget {
  maxIterations: number
  maxTokens?: number
  maxUsd?: number
  noProgress?: { signal: Expr; rounds: number }
}

export interface BaseStep {
  id: StepId
  needs?: ArtifactName[]
  produces?: ArtifactName
  cache?: 'strict' | 'loose'          // default 'strict'
  skipIf?: Expr                        // command/transform/agent: skip entirely, no artifact.
                                        // gate: skip the pause, auto-answer from schema defaults.
  finally?: boolean                    // command/transform/agent/gate: eligible once every `needs`
                                        // producer has settled (completed OR failed), not just
                                        // completed — runs regardless of upstream outcome. A `needs`
                                        // artifact whose producer failed resolves to `undefined`.
                                        // Never un-fails the run: overall status stays 'failed' if
                                        // any non-finally step failed. Default false.
}

export interface AgentStep extends BaseStep {
  kind: 'agent'
  prompt: { file: string } | { inline: string }
  schema?: string | { inline: JSONSchema }   // key in .yak/schemas.ts (Zod, full
                                              // power), or an inline JSON Schema
                                              // (ajv, structural only)
  context?: 'fresh' | { inherit: ArtifactName[] } | { session: StepId }
  tools?: string[]
  model?: string
  repairAttempts?: number              // default 2
  sandbox?: 'docker' | 'none'          // default 'none' — see ticket 07/08, roadmap map
  image?: string                       // overrides the yak-shipped default agent-sandbox image
}

export interface CommandStep extends BaseStep {
  kind: 'command'
  run: string
  cwd?: string
  failOn?: 'exitCode' | 'never'        // default 'exitCode' — see §9 #6
  capture?: ('stdout' | 'stderr' | 'exitCode')[]
  idleTimeoutMs?: number               // default undefined (disabled) — time since last onLine, not total wall clock
  sandbox?: 'docker' | 'none'          // default 'none' — see ticket 04, roadmap map
  image?: string                       // required when sandbox: 'docker', no yak-shipped default
}

export interface TransformStep extends BaseStep {
  kind: 'transform'
  fn: string                           // key in .yak/transforms.ts
}

export interface GateStep extends BaseStep {
  kind: 'gate'
  schema: string | { inline: JSONSchema }
  render: { file: string } | { inline: string }
}

export interface MapStep extends BaseStep {
  kind: 'map'
  over: ArtifactName
  step: Step
  concurrency?: number                 // default 4
  isolation?: 'worktree' | 'none'      // default 'worktree'
  onItemFailure?: 'skip' | 'fail' | 'retry'   // default 'skip'
}

export interface LoopStep extends BaseStep {
  kind: 'loop'
  body: Step[]
  until: Expr
  budget: Budget
  onExhausted?: 'suspend' | 'fail' | 'continue'   // default 'suspend'
  freshContext?: boolean               // default true
}

export type Step =
  | AgentStep | CommandStep | TransformStep
  | GateStep | MapStep | LoopStep

export interface Workflow {
  name: string
  version: string
  inputSchema?: string
  steps: Step[]
}

export interface StepFailure {
  reason:
    | 'needs-decision' | 'needs-context' | 'schema-invalid'
    | 'budget-exhausted' | 'tool-denied' | 'adapter-error' | 'command-failed'
    | 'timeout' | 'sandbox-error'
  detail: string
  recoverable: boolean
}

export type AdapterId = 'mock' | 'claude-code'
export type RunIsolation = 'worktree' | 'none'

export type JournalEvent =
  | { t: 'run.started';      runId: string; workflow: string; inputHash: string; adapter: AdapterId
                             isolation: RunIsolation }
  | { t: 'step.started';     stepId: StepId; iteration?: number
                             semanticKey: string; definitionKey: string }
  | { t: 'step.completed';   stepId: StepId; iteration?: number; artifact?: ArtifactName
                             artifactHash?: string; cached: boolean; stale?: boolean; skipped?: boolean }
  | { t: 'step.failed';      stepId: StepId; iteration?: number; failure: StepFailure }
  | { t: 'artifact.written'; name: ArtifactName; hash: string; bytes: number }
  | { t: 'budget.consumed';  stepId: StepId; tokens: number; usd?: number }
  | { t: 'loop.iteration';   stepId: StepId; n: number; signal?: unknown }
  | { t: 'map.item.retried'; mapStepId: StepId; itemIndex: number; attempt: number; error: string }
  | { t: 'gate.opened';      stepId: StepId; requestPath: string }
  | { t: 'gate.answered';    stepId: StepId; skipped?: boolean }
  | { t: 'run.suspended';    reason: 'gate' | 'budget' | 'exhausted'
                             loopStepId?: StepId; iteration?: number
                             tripped?: 'maxIterations' | 'maxTokens' | 'noProgress' }
  | { t: 'run.finished';     status: 'ok' | 'failed' | 'suspended' }

export type JournalEnvelope = JournalEvent & { at: string; runId: string }
