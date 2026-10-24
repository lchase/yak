import { describe, expect, it } from 'vitest'
import { extractTemplateRoots, renderTemplate } from '../../src/expr/template.js'

describe('renderTemplate', () => {
  it('substitutes a whole-artifact placeholder', async () => {
    const out = await renderTemplate('issue: {{issue}}', { issue: { title: 'x' } })
    expect(out).toBe('issue: {"title":"x"}')
  })

  it('substitutes a dotted field-access placeholder', async () => {
    const out = await renderTemplate('title: {{issue.title}}', { issue: { title: 'Fix bug' } })
    expect(out).toBe('title: Fix bug')
  })

  it('substitutes multiple placeholders in order', async () => {
    const out = await renderTemplate('{{a}} then {{b}}', { a: 'first', b: 'second' })
    expect(out).toBe('first then second')
  })

  it('throws at render time on a missing field', async () => {
    await expect(renderTemplate('{{issue.nope}}', { issue: {} })).rejects.toThrow(/resolved to undefined/)
  })

  it('renders an or-default when the root is missing, and the value when it is present', async () => {
    await expect(renderTemplate('{{ security || "none yet" }}', {})).resolves.toBe('none yet')
    await expect(renderTemplate('{{ security || "none yet" }}', { security: 'real' })).resolves.toBe('real')
  })
})

describe('extractTemplateRoots', () => {
  it('extracts the root identifier of a whole-artifact placeholder', () => {
    expect(extractTemplateRoots('{{issue}}')).toEqual(['issue'])
  })

  it('extracts the root identifier of a dotted placeholder', () => {
    expect(extractTemplateRoots('{{issue.title}}')).toEqual(['issue'])
  })

  it('dedupes repeated roots and preserves distinct ones', () => {
    expect(extractTemplateRoots('{{a.x}} {{a.y}} {{b}}')).toEqual(['a', 'b'])
  })

  it('returns an empty list for a template with no placeholders', () => {
    expect(extractTemplateRoots('no placeholders here')).toEqual([])
  })

  it('takes the leading identifier when the placeholder is an or-default expression', () => {
    expect(extractTemplateRoots('{{ security || "x" }}')).toEqual(['security'])
    expect(extractTemplateRoots('{{ x || "default" }}')).toEqual(['x'])
  })

  it('still takes the root of a dotted expression that falls back with ||', () => {
    expect(extractTemplateRoots('{{ security.findings || "x" }}')).toEqual(['security'])
  })
})
