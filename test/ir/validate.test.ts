import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateWorkflow, WorkflowValidationError } from '../../src/ir/validate.js'
import type { AgentStep, CommandStep, LoopStep, Step, Workflow } from '../../src/ir/types.js'

function workflow(steps: Step[]): Workflow {
  return { name: 'w', version: '1', steps }
}

function command(overrides: Partial<CommandStep> & Pick<CommandStep, 'id'>): CommandStep {
  return { kind: 'command', run: 'echo hi', ...overrides }
}

function agent(overrides: Partial<AgentStep> & Pick<AgentStep, 'id'>): AgentStep {
  return { kind: 'agent', prompt: { inline: 'hi' }, ...overrides }
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
})
