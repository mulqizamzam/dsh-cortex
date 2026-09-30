/** Character gates from DESIGN §3; enforced on write AND on render (P2). */
export interface CortexCaps {
  entryChars: number
  userTrackChars: number
  globalTrackChars: number
  projectTrackChars: number
  todoDigestChars: number
  totalInjectChars: number
  logLineChars: number
  logDayChars: number
  searchResultChars: number
  /** Hard ceiling on total bytes under the state root (DESIGN P2, host #53 class
   * runaway guard). Counted by a throttled walk in the store, not per write. */
  stateQuotaBytes: number
}

export const DEFAULT_CAPS: CortexCaps = {
  entryChars: 400,
  userTrackChars: 4096,
  globalTrackChars: 4096,
  projectTrackChars: 6144,
  todoDigestChars: 1024,
  totalInjectChars: 14000,
  logLineChars: 500,
  logDayChars: 20000,
  searchResultChars: 8000,
  stateQuotaBytes: 67108864,
}

const CAP_KEYS = Object.keys(DEFAULT_CAPS) as (keyof CortexCaps)[]

/** Sanitize + hard-cut a string to `max` chars, marking the cut with `…`. */
export function clampText(input: string, max: number): string {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim()
  if (!Number.isFinite(max) || max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Keep whole items while they fit `max`, then one omission line
 * `[… N more — <hint>]`. The result is always `<= max` (P2 hard ceiling);
 * when even the note cannot fit, nothing is kept.
 */
export function trimToBudget(
  items: readonly string[],
  max: number,
  options: { separator?: string; omitHint?: string } = {},
): { kept: string[]; omitted: number; text: string } {
  const separator = options.separator ?? '\n'
  const hint = options.omitHint ?? 'see Cortex panel'
  const source = [...items]
  if (!Number.isFinite(max) || max <= 0) return { kept: [], omitted: source.length, text: '' }
  const joined = source.join(separator)
  if (joined.length <= max) return { kept: source, omitted: 0, text: joined }
  for (let count = source.length - 1; count >= 0; count -= 1) {
    const kept = source.slice(0, count)
    const omitted = source.length - kept.length
    const candidate = [...kept, `[… ${String(omitted)} more — ${hint}]`].join(separator)
    if (candidate.length <= max) return { kept, omitted, text: candidate }
  }
  return { kept: [], omitted: source.length, text: clampText(`[… ${String(source.length)} more — ${hint}]`, max) }
}

/** Positive-integer coercion; garbage falls back to the shipped default. */
export function capValue(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.floor(numeric)
}

/** Every cap key, for schema/merge code that must not typo a name. */
export function capKeys(): (keyof CortexCaps)[] {
  return [...CAP_KEYS]
}
