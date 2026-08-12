import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ZodType } from 'zod'
import { extractTemplateRoots } from '../expr/template.js'
import { agentInputNames, buildProducerMap, dependenciesOf, flattenSteps } from './graph.js'
import type { ArtifactName, Expr, Step, StepId, Workflow } from './types.js'

export class WorkflowValidationError extends Error {}

const KNOWN_KINDS = new Set(['agent', 'command', 'transform', 'gate', 'map', 'loop'])

/**
 * M2 ticket 01 ("tools mapping to SDK allowedTools"): the confirmed,
 * yak-usable subset of the Claude Agent SDK's public tool names. The SDK's
 * shipped `.d.ts` defines more names than this — internal Claude
 * Code/product surface, not stable third-party API — so only this list is
 * accepted here rather than deferring to the SDK's own (undocumented)
 * unknown-tool-name behavior.
 *
 * `AskUserQuestion` is deliberately excluded (ticket 10's addendum):
 * interactive tools always fall through to a `canUseTool` callback
 * regardless of `permissionMode`, including `bypassPermissions`, and yak
 * has no such callback wired (agent steps have no channel to ask a human,
 * spec §3.6) — declaring it would stall the step at runtime instead of
 * failing at load time.
 */
const KNOWN_AGENT_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'Skill',
])

export async function validateWorkflow(workflow: Workflow, cwd: string = process.cwd()): Promise<void> {
  const flatSteps = flattenSteps(workflow.steps)
  checkKnownKinds(flatSteps)
  checkDuplicateIds(flatSteps)
  const producerOf = buildProducerMap(workflow.steps)
  checkNeedsSatisfied(workflow.steps, producerOf)
  checkNoCycles(workflow.steps, producerOf)
  checkExitCodeReads(workflow.steps, producerOf)
  checkAgentToolNames(flatSteps)
  await checkAgentSchemaKeys(flatSteps, cwd)
  await checkAgentPromptPlaceholders(flatSteps, cwd)
  checkSessionChainDepth(flatSteps)
  checkMapIsolation(workflow.steps)
}

/** Ticket 07: real worktree isolation is M5's job — requesting it explicitly
 * is a load-time error in M3, not a silent no-op. `isolation: 'none'` (the
 * M3 default) means concurrent items literally share one process cwd, so
 * `concurrency > 1` with a write-capable item step (`Edit`, `Write`, or
 * `Bash` — `Bash` counts as write-capable since the engine can't tell
 * read-only shell usage from a mutating one) is a structural race the
 * loader can catch, not a caller footgun to document and hope is avoided. */
const WRITE_CAPABLE_TOOLS = new Set(['Edit', 'Write', 'Bash'])

function checkMapIsolation(steps: Step[]): void {
  for (const step of steps) {
    if (step.kind === 'loop') checkMapIsolation(step.body)
    if (step.kind !== 'map') continue

    if (step.isolation === 'worktree') {
      throw new WorkflowValidationError(
        `step "${step.id}": isolation: 'worktree' is not supported until M5 — use isolation: 'none' ` +
          `(M3's default) or omit isolation`,
      )
    }

    const concurrency = step.concurrency ?? 4
    if (concurrency > 1 && step.step.kind === 'agent') {
      const writeTool = (step.step.tools ?? []).find((tool) => WRITE_CAPABLE_TOOLS.has(tool))
      if (writeTool) {
        throw new WorkflowValidationError(
          `step "${step.id}": isolation: 'none' with concurrency ${concurrency} and item step ` +
            `"${step.step.id}" declaring write-capable tool "${writeTool}" — concurrent items would ` +
            `share one cwd and race; use concurrency: 1 or drop the write-capable tool`,
        )
      }
    }

    checkMapIsolation([step.step])
  }
}

function checkAgentToolNames(steps: Step[]): void {
  for (const step of steps) {
    if (step.kind !== 'agent') continue
    for (const tool of step.tools ?? []) {
      if (!KNOWN_AGENT_TOOLS.has(tool)) {
        throw new WorkflowValidationError(
          `step "${step.id}": unknown or unsupported tool "${tool}" — must be one of ` +
            `${[...KNOWN_AGENT_TOOLS].join(', ')}`,
        )
      }
    }
  }
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

/** Ticket 01: a body step's `needs` resolves first against its own loop's
 * local producer map (other body steps), falling through to the outer
 * scope's producer map — an artifact produced only inside a loop is never
 * visible outside it, so the outer scope passed to a nested loop is never
 * widened with that loop's own locals. */
function checkNeedsSatisfied(steps: Step[], producerOf: Map<ArtifactName, StepId>): void {
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      if (!producerOf.has(need)) {
        throw new WorkflowValidationError(
          `step "${step.id}": needs artifact "${need}" but no step produces it`,
        )
      }
    }
    if (step.kind === 'loop') {
      const localProducerOf = new Map([...producerOf, ...buildProducerMap(step.body)])
      checkNeedsSatisfied(step.body, localProducerOf)
    }
    if (step.kind === 'map') {
      checkNeedsSatisfied([step.step], producerOf)
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

/** §13 `AgentStep.schema` is "a key in .yak/schemas.ts" — reject an unknown
 * key at load time rather than failing the first time the step runs. */
async function checkAgentSchemaKeys(steps: Step[], cwd: string): Promise<void> {
  for (const step of steps) {
    if (step.kind !== 'agent' || !step.schema) continue

    const modulePath = path.resolve(cwd, '.yak/schemas.ts')
    let mod: Record<string, unknown>
    try {
      mod = await import(pathToFileURL(modulePath).href)
    } catch (err) {
      throw new WorkflowValidationError(
        `step "${step.id}": could not load .yak/schemas.ts to resolve schema "${step.schema}": ` +
          `${(err as Error).message}`,
      )
    }
    if (!(mod[step.schema] instanceof ZodType)) {
      throw new WorkflowValidationError(
        `step "${step.id}": schema "${step.schema}" not found in .yak/schemas.ts`,
      )
    }
  }
}

/** A prompt placeholder's root must be a declared input — `needs` or
 * `context.inherit` — otherwise the dependency graph is lying about what
 * the step actually reads. */
async function checkAgentPromptPlaceholders(steps: Step[], cwd: string): Promise<void> {
  for (const step of steps) {
    if (step.kind !== 'agent') continue

    const text =
      'file' in step.prompt
        ? await readFile(path.resolve(cwd, step.prompt.file), 'utf8')
        : step.prompt.inline

    const allowed = new Set(agentInputNames(step))

    for (const root of extractTemplateRoots(text)) {
      if (!allowed.has(root)) {
        throw new WorkflowValidationError(
          `step "${step.id}": prompt references "{{${root}}}" but "${root}" is not in ` +
            `needs or context.inherit`,
        )
      }
    }
  }
}

/** §3.4: the engine "warns when a chain [of context.session resumes]
 * exceeds 3" — a warning, not a load-time failure, since a long chain is
 * discouraged but not invalid. */
function checkSessionChainDepth(steps: Step[]): void {
  const stepsById = new Map(steps.map((s) => [s.id, s]))

  function sessionParentOf(step: Step): StepId | undefined {
    if (step.kind !== 'agent') return undefined
    if (typeof step.context !== 'object' || !('session' in step.context)) return undefined
    return step.context.session
  }

  for (const step of steps) {
    if (step.kind !== 'agent') continue
    let depth = 0
    let current = sessionParentOf(step)
    const seen = new Set<StepId>([step.id])

    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      depth += 1
      const parentStep = stepsById.get(current)
      current = parentStep ? sessionParentOf(parentStep) : undefined
    }

    if (depth > 3) {
      console.warn(
        `step "${step.id}": context.session chain exceeds depth 3 (depth ${depth}) — ` +
          `spec §3.4 discourages long resume chains`,
      )
    }
  }
}
