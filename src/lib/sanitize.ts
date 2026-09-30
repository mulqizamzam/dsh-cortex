/**
 * Brace neutralization for anything a model can see (host issue-class #53).
 *
 * A `{{` / `}}` pair inside model-visible text (tool descriptions, parameter
 * descriptions, injected context, tool output) can throw inside the host prompt
 * renderer and deadlock EVERY subsequent turn of the session — a plugin that
 * lets user- or AI-authored braces reach the renderer takes the GUI down with
 * it. So: braces never ship in model-visible text.
 *
 * The rule is "insert a space inside every adjacent same-brace run", which is
 * what Amendment 3 asked for (`{{` → `{ {`, `}}` → `{ }`) made total: a literal
 * one-pass `replaceAll` is NOT safe — `{{{{` becomes `{ {{`, i.e. it re-forms a
 * pair — and mapping a closing `}}` to `{ }` also flips brace direction, which
 * changes meaning. Breaking runs inserts whitespace only, never edits a brace,
 * and is provably idempotent (`neutralize(neutralize(x)) === neutralize(x)`)
 * with no pair left in the output.
 *
 * Lossy BY DESIGN: `{ {` reads the same to a model and no longer parses as a
 * template delimiter. A single brace is untouched — it is not the trigger.
 *
 * Pure, allocation-light, never throws — every write edge (store) and every
 * render edge (injection blocks, tool results, tool/param descriptions) must
 * call it.
 */
export function neutralize(input: string): string {
  if (typeof input !== 'string' || input === '') return ''
  if (!input.includes('{{') && !input.includes('}}')) return input
  // One pass that breaks EVERY adjacent run: a naive replaceAll is not enough,
  // because `{{{{` → `{ {{` re-forms a pair on the next character. Splitting
  // runs is exactly the fixpoint of the documented rule, and it is idempotent.
  let output = ''
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string
    output += char
    const next = input[index + 1]
    if ((char === '{' || char === '}') && next === char) output += ' '
  }
  return output
}

/** True when the text still carries a delimiter pair (test/assertion helper). */
export function hasBracePair(input: string): boolean {
  return typeof input === 'string' && (input.includes('{{') || input.includes('}}'))
}

/** `neutralize` over a list, dropping nothing (render-loop helper). */
export function neutralizeAll(items: readonly string[]): string[] {
  return items.map(item => neutralize(item))
}

/** Deep-walk a JSON-ish value and neutralize every string leaf. Render edges
 * that emit whole objects (tool output, RPC payloads) use this as the final
 * belt-and-braces so nested user-authored strings can never smuggle a pair. */
export function neutralizeDeep<T>(value: T): T {
  if (typeof value === 'string') return neutralize(value) as unknown as T
  if (Array.isArray(value)) return value.map(item => neutralizeDeep(item)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = neutralizeDeep(item)
    return out as unknown as T
  }
  return value
}
