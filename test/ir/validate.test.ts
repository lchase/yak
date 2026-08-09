import { describe, expect, it } from 'vitest'
import { validateWorkflow, WorkflowValidationError } from '../../src/ir/validate.js'
import type { CommandStep, LoopStep, Step, Workflow } from '../../src/ir/types.js'

function workflow(steps: Step[]): Workflow {
  return { name: 'w', version: '1', steps }
}

function command(overrides: Partial<CommandStep> & Pick<CommandStep, 'id'>): CommandStep {
  return { kind: 'command', run: 'echo hi', ...overrides }
}

describe('validateWorkflow', () => {
  it('accepts a valid acyclic graph', () => {
    const wf = workflow([
      command({ id: 'a', produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it('rejects unknown step kinds', () => {
    const wf = workflow([{ id: 'a', kind: 'bogus' } as unknown as Step])
    expect(() => validateWorkflow(wf)).toThrow(WorkflowValidationError)
  })

  it('rejects duplicate step ids', () => {
    const wf = workflow([command({ id: 'a' }), command({ id: 'a' })])
    expect(() => validateWorkflow(wf)).toThrow(/duplicate step id/)
  })

  it('rejects needs referencing an artifact no step produces', () => {
    const wf = workflow([command({ id: 'a', needs: ['missing'] })])
    expect(() => validateWorkflow(wf)).toThrow(/needs artifact "missing"/)
  })

  it('rejects cycles', () => {
    const wf = workflow([
      command({ id: 'a', needs: ['b-out'], produces: 'a-out' }),
      command({ id: 'b', needs: ['a-out'], produces: 'b-out' }),
    ])
    expect(() => validateWorkflow(wf)).toThrow(/cycle detected/)
  })

  it('rejects reading <step>.exitCode downstream of a step with failOn: exitCode', () => {
    const loop: LoopStep = {
      id: 'retry',
      kind: 'loop',
      needs: ['test-result'],
      body: [],
      until: 'test-result.exitCode == 0',
      budget: { maxIterations: 3 },
    }
    const wf = workflow([command({ id: 'test', produces: 'test-result' }), loop])
    expect(() => validateWorkflow(wf)).toThrow(/failOn: 'exitCode'/)
  })

  it('allows reading <step>.exitCode when the producing step has failOn: never', () => {
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
    expect(() => validateWorkflow(wf)).not.toThrow()
  })
})
