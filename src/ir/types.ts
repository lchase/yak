export type StepId = string
export type ArtifactName = string

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
}

export interface AgentStep extends BaseStep {
  kind: 'agent'
  prompt: { file: string } | { inline: string }
  schema?: string                      // key in .yak/schemas.ts
  context?: 'fresh' | { inherit: ArtifactName[] } | { session: StepId }
  tools?: string[]
  model?: string
  repairAttempts?: number              // default 2
}

export interface CommandStep extends BaseStep {
  kind: 'command'
  run: string
  cwd?: string
  failOn?: 'exitCode' | 'never'        // default 'exitCode' — see §9 #6
  capture?: ('stdout' | 'stderr' | 'exitCode')[]
}

export interface TransformStep extends BaseStep {
  kind: 'transform'
  fn: string                           // key in .yak/transforms.ts
}

export interface GateStep extends BaseStep {
  kind: 'gate'
  schema: string
  render: { file: string } | { inline: string }
  skipIf?: Expr
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
                             artifactHash?: string; cached: boolean; stale?: boolean }
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
