import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateWorkflow, WorkflowValidationError } from '../../src/ir/validate.js'
import type { AgentStep, CommandStep, GateStep, LoopStep, MapStep, Step, Workflow } from '../../src/ir/types.js'

function workflow(steps: Step[]): Workflow {
  return { name: 'w', version: '1', steps }
}

function command(overrides: Partial<CommandStep> & Pick<CommandStep, 'id'>): CommandStep {
  return { kind: 'command', run: 'echo hi', ...overrides }
}

function agent(overrides: Partial<AgentStep> & Pick<AgentStep, 'id'>): AgentStep {
  return { kind: 'agent', prompt: { inline: 'hi' }, ...overrides }
}

function map(overrides: Partial<MapStep> & Pick<MapStep, 'id' | 'over' | 'step'>): MapStep {
  return { kind: 'map', isolation: 'none', ...overrides }
}

function gate(overrides: Partial<GateStep> & Pick<GateStep, 'id' | 'schema'>): GateStep {
  return { kind: 'gate', render: { inline: 'approve?' }, ...overrides }
}

describe('validateWorkflow', () => {
  it('accepts a valid acyclic graph', async () => {
    const wf = workflow([
      command({ id: 'a', produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    await expect(validateWorkflow(wf)).resolves.toBeUndefined()
  })

  it('rejects unknown step kinds', async () => {
    const wf = workflow([{ id: 'a', kind: 'bogus' } as unknown as Step])
    await expect(validateWorkflow(wf)).rejects.toThrow(WorkflowValidationError)
  })

  it('rejects duplicate step ids', async () => {
    const wf = workflow([command({ id: 'a' }), command({ id: 'a' })])
    await expect(validateWorkflow(wf)).rejects.toThrow(/duplicate step id/)
  })

  it('rejects needs referencing an artifact no step produces', async () => {
    const wf = workflow([command({ id: 'a', needs: ['missing'] })])
    await expect(validateWorkflow(wf)).rejects.toThrow(/needs artifact "missing"/)
  })

  it('rejects cycles', async () => {
    const wf = workflow([
      command({ id: 'a', needs: ['b-out'], produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    await expect(validateWorkflow(wf)).rejects.toThrow(/cycle detected/)
  })

  it('rejects reading <step>.exitCode downstream of a step with failOn: exitCode', async () => {
    const loop: LoopStep = {
      id: 'retry',
      kind: 'loop',
      needs: ['test-result'],
      body: [],
      until: 'test-result.exitCode == 0',
      budget: { maxIterations: 3 },
    }
    const wf = workflow([command({ id: 'test', produces: 'test-result' }), loop])
    await expect(validateWorkflow(wf)).rejects.toThrow(/failOn: 'exitCode'/)
  })

  it('allows reading <step>.exitCode when the producing step has failOn: never', async () => {
    const loop: LoopStep = {
      id: 'retry',
      kind: 'loop',
      needs: ['test-result'],
      body: [],
      until: 'test-result.exitCode == 0',
      budget: { maxIterations: 3 },
    }
    const wf = workflow([
      command({ id: 'test', produces: 'test-result', failOn: 'never' }),
      loop,
    ])
    await expect(validateWorkflow(wf)).resolves.toBeUndefined()
  })

  describe('ticket 07: isolation: "none" write-race guardrail', () => {
    it('rejects concurrency > 1 with a write-capable tool (Edit) on the item step', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Read', 'Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(/isolation: 'none'.*concurrency.*write/is)
    })

    it('rejects concurrency > 1 with Bash on the item step — Bash counts as write-capable', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 2,
          step: agent({ id: 'review-one', tools: ['Bash'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(/isolation: 'none'/)
    })

    it('allows concurrency > 1 with only read-only tools on the item step', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Read', 'Grep'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('allows concurrency: 1 with write-capable tools — no concurrent writers to race', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          concurrency: 1,
          step: agent({ id: 'review-one', tools: ['Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('allows isolation: "worktree" with concurrency > 1 and write tools when the run itself is worktree-isolated', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          isolation: 'worktree',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf, undefined, 'worktree')).resolves.toBeUndefined()
    })

    it('rejects isolation: "worktree" on a map step when the run itself is not --isolation worktree', async () => {
      const wf = workflow([
        command({ id: 'files', produces: 'changed-files' }),
        map({
          id: 'review',
          over: 'changed-files',
          isolation: 'worktree',
          concurrency: 5,
          step: agent({ id: 'review-one', tools: ['Edit'] }),
        }),
      ])
      await expect(validateWorkflow(wf)).rejects.toThrow(/isolation: 'worktree'.*requires the run itself/is)
    })
  })

  describe('agent step tool names', () => {
    it('accepts known tool names', async () => {
      const wf = workflow([agent({ id: 'code', tools: ['Read', 'Edit', 'Bash'] })])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects an unknown tool name', async () => {
      const wf = workflow([agent({ id: 'code', tools: ['Read', 'Frobnicate'] })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/unknown or unsupported tool "Frobnicate"/)
    })

    it('rejects AskUserQuestion — no canUseTool channel to resolve it', async () => {
      const wf = workflow([agent({ id: 'code', tools: ['AskUserQuestion'] })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/unknown or unsupported tool "AskUserQuestion"/)
    })
  })

  describe('agent step schema keys', () => {
    let cwd: string

    beforeEach(async () => {
      cwd = await mkdtemp(path.join(tmpdir(), 'yak-validate-'))
      await mkdir(path.join(cwd, '.yak'), { recursive: true })
      await writeFile(
        path.join(cwd, '.yak', 'schemas.ts'),
        `import { z } from 'zod'\nexport const PlanSchema = z.object({ summary: z.string() })\n`,
        'utf8',
      )
    })

    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true })
    })

    it('accepts a schema key that resolves to a ZodType', async () => {
      const wf = workflow([agent({ id: 'plan', schema: 'PlanSchema' })])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('rejects a schema key missing from .yak/schemas.ts', async () => {
      const wf = workflow([agent({ id: 'plan', schema: 'Nope' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/schema "Nope" not found/)
    })

    it('roadmap ticket 09: accepts a well-formed inline JSON Schema', async () => {
      const wf = workflow([
        agent({
          id: 'plan',
          schema: { inline: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('roadmap ticket 09: rejects a malformed inline JSON Schema at load time', async () => {
      const wf = workflow([agent({ id: 'plan', schema: { inline: { type: 'not-a-real-type' } } })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/could not resolve schema inline schema/)
    })
  })

  describe('M4: gate step schema keys, skipIf defaults, flat-schema, render placeholders', () => {
    let cwd: string

    async function withSchema(source: string): Promise<void> {
      await writeFile(path.join(cwd, '.yak', 'schemas.ts'), source, 'utf8')
    }

    beforeEach(async () => {
      cwd = await mkdtemp(path.join(tmpdir(), 'yak-validate-gate-'))
      await mkdir(path.join(cwd, '.yak'), { recursive: true })
      await withSchema(
        `import { z } from 'zod'\n` +
          `export const ApprovalSchema = z.object({ decision: z.enum(['approve','reject']) })\n` +
          `export const AutoApprovalSchema = z.object({ decision: z.enum(['approve','reject']).default('approve') })\n` +
          `export const NestedSchema = z.object({ inner: z.object({ x: z.string() }) })\n`,
      )
    })

    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true })
    })

    it('accepts a schema key that resolves to a ZodType', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'ApprovalSchema' })])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('rejects a schema key missing from .yak/schemas.ts', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'Nope' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/schema "Nope" not found/)
    })

    it('ticket 05: rejects skipIf when the schema does not default every field', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'ApprovalSchema', skipIf: 'true' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/doesn't default every field/)
    })

    it('ticket 05: accepts skipIf when every field defaults', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'AutoApprovalSchema', skipIf: 'true' })])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('ticket 04: rejects a nested (non-flat) answer schema at load time', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'NestedSchema' })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/not a flat scalar\/enum type/)
    })

    it('accepts a render placeholder declared in needs', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'plan' }),
        gate({ id: 'approve', schema: 'ApprovalSchema', needs: ['plan'], render: { inline: '{{plan}}' } }),
      ])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('rejects a render placeholder not in needs', async () => {
      const wf = workflow([gate({ id: 'approve', schema: 'ApprovalSchema', render: { inline: '{{plan}}' } })])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/"plan" is not in needs/)
    })

    it('roadmap ticket 09: accepts an inline JSON Schema with skipIf when every field defaults', async () => {
      const wf = workflow([
        gate({
          id: 'approve',
          schema: {
            inline: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['approve', 'reject'], default: 'approve' } },
            },
          },
          skipIf: 'true',
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).resolves.toBeUndefined()
    })

    it('roadmap ticket 09: rejects skipIf on an inline schema that does not default every field', async () => {
      const wf = workflow([
        gate({
          id: 'approve',
          schema: {
            inline: { type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'reject'] } }, required: ['decision'] },
          },
          skipIf: 'true',
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/doesn't default every field/)
    })

    it('roadmap ticket 09: rejects a nested inline answer schema at load time', async () => {
      const wf = workflow([
        gate({
          id: 'approve',
          schema: { inline: { type: 'object', properties: { inner: { type: 'object', properties: { x: { type: 'string' } } } } } },
        }),
      ])
      await expect(validateWorkflow(wf, cwd)).rejects.toThrow(/not a flat scalar\/enum type/)
    })
  })

  describe('agent prompt placeholder roots', () => {
    it('accepts a placeholder root declared in needs', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'issue' }),
        agent({ id: 'plan', needs: ['issue'], prompt: { inline: 'title: {{issue.title}}' } }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('accepts a placeholder root declared via context.inherit', async () => {
      const wf = workflow([
        command({ id: 'src', produces: 'plan' }),
        agent({
          id: 'code',
          context: { inherit: ['plan'] },
          prompt: { inline: 'plan: {{plan}}' },
        }),
      ])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects a placeholder root not in needs or context.inherit', async () => {
      const wf = workflow([agent({ id: 'plan', prompt: { inline: '{{issue.title}}' } })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/"issue" is not in needs or context.inherit/)
    })
  })

  describe('context.session chain depth', () => {
    it('does not warn for a chain of depth 3 or fewer', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wf = workflow([
        agent({ id: 'a' }),
        agent({ id: 'b', context: { session: 'a' } }),
        agent({ id: 'c', context: { session: 'b' } }),
      ])
      await validateWorkflow(wf)
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('warns when a chain exceeds depth 3', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wf = workflow([
        agent({ id: 'a' }),
        agent({ id: 'b', context: { session: 'a' } }),
        agent({ id: 'c', context: { session: 'b' } }),
        agent({ id: 'd', context: { session: 'c' } }),
        agent({ id: 'e', context: { session: 'd' } }),
      ])
      await validateWorkflow(wf)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/exceeds depth 3/))
      warn.mockRestore()
    })
  })

  describe('sandbox: docker', () => {
    it('rejects a command step with sandbox: docker but no image', async () => {
      const wf = workflow([command({ id: 'a', sandbox: 'docker' })])
      await expect(validateWorkflow(wf)).rejects.toThrow(/requires an "image" field/)
    })

    it('accepts a command step with sandbox: docker and an image, when docker is on PATH', async () => {
      const wf = workflow([command({ id: 'a', sandbox: 'docker', image: 'node:22' })])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects sandbox: docker workflows when the docker binary is not on PATH', async () => {
      const wf = workflow([command({ id: 'a', sandbox: 'docker', image: 'node:22' })])
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        await expect(validateWorkflow(wf)).rejects.toThrow(/"docker" binary was not found on PATH/)
      } finally {
        process.env.PATH = originalPath
      }
    })

    it('does not check for docker when no step uses sandbox: docker', async () => {
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        const wf = workflow([command({ id: 'a' })])
        await expect(validateWorkflow(wf)).resolves.toBeUndefined()
      } finally {
        process.env.PATH = originalPath
      }
    })

    // Ticket 07/08: unlike `command`, an `agent` step's `image` is optional
    // (yak ships a default) — only the docker-on-PATH check applies.
    it('accepts an agent step with sandbox: docker and no image, when docker is on PATH', async () => {
      const wf = workflow([agent({ id: 'a', sandbox: 'docker' })])
      await expect(validateWorkflow(wf)).resolves.toBeUndefined()
    })

    it('rejects sandbox: docker on an agent step when the docker binary is not on PATH', async () => {
      const wf = workflow([agent({ id: 'a', sandbox: 'docker' })])
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        await expect(validateWorkflow(wf)).rejects.toThrow(/"docker" binary was not found on PATH/)
      } finally {
        process.env.PATH = originalPath
      }
    })
  })
})
