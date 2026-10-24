import jexl from 'jexl'

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g
const ROOT_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*/

/** The root identifier each `{{...}}` placeholder reads from — used by
 * validate.ts's load-time check that every root is in `needs ∪ context.inherit`.
 * Only the leading identifier counts, so `{{ security.findings }}` and
 * `{{ security || "none yet" }}` both root at `security`. */
export function extractTemplateRoots(template: string): string[] {
  const roots = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const expr = match[1]!.trim()
    const root = ROOT_IDENTIFIER.exec(expr)?.[0]
    if (root) roots.add(root)
  }
  return [...roots]
}

export async function renderTemplate(template: string, inputs: Record<string, unknown>): Promise<string> {
  let result = ''
  let lastIndex = 0

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const [full, exprRaw] = match
    const expr = exprRaw!.trim()
    const start = match.index!

    const value = await jexl.eval(expr, inputs)
    if (value === undefined) {
      throw new Error(`prompt template placeholder "{{${expr}}}" resolved to undefined`)
    }

    result += template.slice(lastIndex, start)
    result += typeof value === 'string' ? value : JSON.stringify(value)
    lastIndex = start + full.length
  }

  result += template.slice(lastIndex)
  return result
}
