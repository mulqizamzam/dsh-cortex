/**
 * Todo digest: parsing, ordering and rendering (DESIGN §3 todoDigestChars,
 * §4 `cortex_todo_*`).
 *
 * Everything here is pure — no store, no fs, no host — so the budget/label/
 * ordering rules are unit-testable without a host or a git binary.
 *
 * Two invariants the rest of the module depends on:
 *  - every rendered string is `neutralize()`-ed at THIS edge (P9 / host issue
 *    class #53: a brace pair in model-visible text deadlocks the session), and
 *  - the returned block never exceeds `budget` characters, including the label
 *    (P2). A budget too small to carry the honest label contributes NOTHING —
 *    an unlabelled block is forbidden (P1), and truncating the label would be
 *    the same lie, so silence is the only correct answer.
 */
import { clampText, trimToBudget } from '../../../lib/caps.ts'
import { isIsoDate } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { TodoItem } from '../../types.ts'

/** Registered name of the M3 injection context (duplicate names throw). */
export const TODO_CONTEXT_NAME = 'cortex:todo'
/** Order of that context: after memory (40), before rooms/prompts (42/43). */
export const TODO_CONTEXT_ORDER = 41

/** Per-line text ceiling inside the digest; the panel shows the full text. */
export const DIGEST_LINE_TEXT_CHARS = 180

/** The empty-state line. Nothing else is rendered when there is no work. */
export const EMPTY_DIGEST_LINE = '## Open todos (dsh-cortex): no open todos'

/** Tracks a todo may live in (DESIGN §4). */
export const TODO_TRACKS = ['life', 'work', 'daily', 'project'] as const

const MS_PER_DAY = 86_400_000

export type DueParse = { ok: true; due?: string } | { ok: false; error: string }

/**
 * Accept `YYYY-MM-DD` and nothing else (DESIGN §4 due), including a real
 * calendar check — `2026-02-31` matches the shape but is not a date. Anything
 * else is an honest reject: we never guess that "next friday" means a Sunday.
 */
export function parseDue(raw: unknown): DueParse {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'string') return { ok: false, error: 'due must be a YYYY-MM-DD string' }
  const value = raw.trim()
  if (value === '') return { ok: true }
  if (!isIsoDate(value)) return { ok: false, error: `due must be YYYY-MM-DD (got "${clampText(value, 40)}")` }
  const [year = 0, month = 0, day = 0] = value.split('-').map(part => Number.parseInt(part, 10))
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { ok: false, error: `due is not a real calendar date: ${value}` }
  }
  return { ok: true, due: value }
}

/** Whole days from `today` to `due`; negative means overdue. */
export function daysUntil(due: string, today: string): number {
  const then = Date.parse(`${due}T00:00:00Z`)
  const now = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 0
  return Math.round((then - now) / MS_PER_DAY)
}

/** Overdue = due strictly before today (due today is not overdue). */
export function isOverdue(due: string | undefined, today: string): boolean {
  return due !== undefined && daysUntil(due, today) < 0
}

function rank(item: TodoItem): number {
  if (item.urgent === true) return 0
  if (item.important === true) return 1
  return 2
}

/**
 * Digest order: dated items first (due ascending, overdue therefore on top),
 * then importance (urgent, important, plain) as the tie-break, then age — the
 * item nobody has touched in three weeks outranks one filed a minute ago.
 */
export function orderForDigest(items: readonly TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    const aDue = typeof a.due === 'string' && a.due !== ''
    const bDue = typeof b.due === 'string' && b.due !== ''
    if (aDue !== bDue) return aDue ? -1 : 1
    if (aDue && bDue && a.due !== b.due) return (a.due as string).localeCompare(b.due as string)
    return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  })
}

/** One digest line: state, text, due/overdue, then the bucket it belongs to. */
export function formatTodoLine(item: TodoItem, today: string): string {
  const marks: string[] = []
  if (item.urgent === true) marks.push('urgent')
  if (item.important === true) marks.push('important')
  const parts = [`- ${item.done ? '[x]' : '[ ]'} ${clampText(neutralize(item.text), DIGEST_LINE_TEXT_CHARS)}`]
  if (marks.length > 0) parts.push(marks.join(', '))
  if (typeof item.due === 'string' && item.due !== '') {
    const delta = daysUntil(item.due, today)
    parts.push(delta < 0 ? `due ${item.due} (OVERDUE ${String(-delta)}d)` : `due ${item.due}`)
  }
  parts.push(`[${item.track}]`)
  return parts.join(' · ')
}

export interface DigestInput {
  /** OPEN items only; done items are never rendered (the panel shows them). */
  items: readonly TodoItem[]
  /** The P1 honest label, verbatim, from `cfg().injectLabel`. */
  label: string
  /** Hard ceiling on the WHOLE block, label included (caps.todoDigestChars). */
  budget: number
  /** Today as `YYYY-MM-DD`, for the overdue flag. */
  today: string
  /** Short project marker appended to the header when a pid scope is active. */
  projectName?: string
}

export interface DigestResult {
  text: string
  /** Items actually rendered (the rest is counted, never dropped silently). */
  shown: number
  omitted: number
  overdue: number
  /** True when the block was suppressed because the budget could not hold it. */
  suppressed: boolean
}

/** Header of the todo block: honest counts, no editorialising. */
export function todoHeader(open: number, overdue: number, projectName?: string): string {
  const scope = projectName === undefined || projectName === '' ? '' : ` — ${clampText(neutralize(projectName), 40)}`
  const flag = overdue > 0 ? `${String(overdue)} overdue` : 'none overdue'
  return `## Open todos (dsh-cortex — reference data${scope}; ${String(open)} open, ${flag})`
}

/**
 * Render the digest. Returns `text: ''` when there is nothing to contribute or
 * the budget cannot carry the label — the caller must not fake a summary.
 */
export function renderTodoDigest(input: DigestInput): DigestResult {
  const label = neutralize(input.label)
  const budget = Number.isFinite(input.budget) ? Math.floor(input.budget) : 0
  // Even a suppressed render reports the real counts: a caller must be able to
  // tell "nothing was shown" from "nothing exists" (P2 honesty).
  const report = (overdue: number, text: string, shown: number, omitted: number, suppressed: boolean): DigestResult =>
    ({ text, shown, omitted, overdue, suppressed })

  const openItems = input.items.filter(item => item.done !== true)
  if (openItems.length === 0) {
    const block = `${label}\n${EMPTY_DIGEST_LINE}`
    // The empty state is one honest line; if even that will not fit, stay silent.
    return block.length <= budget ? report(0, block, 0, 0, false) : report(0, '', 0, 0, true)
  }

  const overdue = openItems.filter(entry => isOverdue(entry.due, input.today)).length
  const header = todoHeader(openItems.length, overdue, input.projectName)
  const lines = orderForDigest(openItems).map(entry => formatTodoLine(entry, input.today))
  const used = `${label}\n${header}`.length
  const itemBudget = budget - used - 1
  if (itemBudget <= 0) return report(overdue, '', 0, openItems.length, true)

  const trimmed = trimToBudget(lines, itemBudget, { separator: '\n', omitHint: 'see the Cortex panel or cortex_todo_list' })
  const block = `${label}\n${header}\n${trimmed.text}`
  if (block.length > budget) return report(overdue, '', 0, openItems.length, true)
  return report(overdue, block, trimmed.kept.length, trimmed.omitted, false)
}

/** Store rows sorted for `cortex_todo_list`: same order as the digest. */
export function formatTodoList(items: readonly TodoItem[], today: string): string[] {
  return orderForDigest(items).map(item => `${formatTodoLine(item, today)} id=${item.id}`)
}
