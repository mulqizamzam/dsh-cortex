/**
 * Progress report — pure composition, zero invention (DESIGN §4, §9.1 G-06).
 *
 * `cortex_progress_report` does not summarise anything. It concatenates three
 * things the store already holds — open todos, the tail of the recent log days,
 * the newest active project entries — under an honest label, inside a hard
 * 4 000-character budget, and says which parts were truncated. If the store is
 * empty the report says the store is empty; it never dresses that up.
 *
 * `collectProgress` is the only half that touches the store; `renderProgress`
 * is pure, so the budget and the label are testable without a filesystem.
 */
import { clampText, trimToBudget } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { Entry, LogRef, TodoItem } from '../../types.ts'
import { formatTodoLine, orderForDigest } from '../todo/digest.ts'
import { shapeLogText } from '../logs/service.ts'

/** Output ceiling for one report (brief: budgeted ≤ 4000 chars). */
export const PROGRESS_BUDGET_CHARS = 4000

/** Log window: three days is "recent" without being the whole history. */
export const PROGRESS_LOG_DAYS = 3

/** Newest active project entries listed in one report. */
export const PROGRESS_ENTRY_LIMIT = 8

export interface ProgressInput {
  label: string
  today: string
  todos: TodoItem[]
  /** Per-scope log reads, already labelled by the collector. */
  logs: Array<{ scope: LogRef['scope']; text: string; error?: string }>
  entries: Entry[]
  /** Project id marker for the header, when a scope resolved. */
  pid?: string
  /** Whole-report budget; defaults to `PROGRESS_BUDGET_CHARS`. */
  budget?: number
  /** True when a store read failed and the sections below are partial. */
  readErrors?: string[]
}

export interface ProgressResult {
  text: string
  lines: number
  omitted: number
  truncated: boolean
}

function entryLine(entry: Entry): string {
  const scope = Array.isArray(entry.branches) && entry.branches.length > 0 ? ` branch:${entry.branches.map(item => neutralize(String(item))).join(',')}` : ''
  return `- [${neutralize(String(entry.id))}] (i${String(entry.importance)}${scope}) ${clampText(neutralize(String(entry.content ?? '')), 200)}`
}

function logBlock(section: { scope: LogRef['scope']; text: string; error?: string }): string[] {
  if (section.error !== undefined) return [`### log (${section.scope}) — read failed: ${neutralize(section.error)}`]
  const shaped = shapeLogText(section.text)
  const title = `### log (${section.scope}) — ${String(shaped.count)} line(s), newest last`
  if (shaped.lines.length === 0) return [title, '(nothing recorded)']
  return [title, ...shaped.lines.slice(-20)]
}

/** Header line: the report's own identity, with the counts it is about to show. */
export function progressHeader(open: number, entries: number, projectName?: string): string {
  const scope = projectName === undefined || projectName === '' ? '' : ` — ${clampText(neutralize(projectName), 40)}`
  return `## Progress report (dsh-cortex — composed from stored todos, logs and entries; nothing summarised automatically${scope})`
    + `\n${String(open)} open todo(s), ${String(entries)} recent project entr(ies)`
}

/** Pure assembly. Budget applies to the WHOLE block, label included (P2). */
export function renderProgress(input: ProgressInput): ProgressResult {
  const budget = input.budget ?? PROGRESS_BUDGET_CHARS
  const label = neutralize(input.label)
  const open = input.todos.filter(item => item.done !== true)
  const header = progressHeader(open.length, input.entries.length, input.pid === undefined ? undefined : `${input.pid.slice(0, 8)}…`)

  const lines: string[] = []
  lines.push('### open todos')
  if (open.length === 0) lines.push('(none)')
  else lines.push(...orderForDigest(open).map(item => formatTodoLine(item, input.today)))

  lines.push(...input.logs.flatMap(section => logBlock(section)))

  lines.push(`### newest project entries (${String(input.entries.length)} most recent, active only)`)
  if (input.entries.length === 0) lines.push('(none — cortex_memory_remember stores them)')
  else lines.push(...input.entries.map(entryLine))

  const errors = (input.readErrors ?? []).map(item => `[…] read failed: ${neutralize(item)}`)

  // The framing is not negotiable: a block whose label or header had to be cut
  // is not a smaller honest block, it is a lie about who wrote it (P1). If the
  // budget cannot carry the framing plus one line, nothing is rendered.
  const framing = `${label}\n${header}`
  if (framing.length + 1 >= budget) {
    return { text: '', lines: 0, omitted: lines.length, truncated: true }
  }
  const trimmed = trimToBudget([...errors, ...lines], budget - framing.length - 1, { separator: '\n', omitHint: 'report truncated — see the Cortex panel' })
  const text = `${framing}\n${trimmed.text}`
  if (text.length > budget) return { text: '', lines: 0, omitted: lines.length, truncated: true }
  return {
    text,
    lines: trimmed.kept.length,
    omitted: trimmed.omitted,
    truncated: trimmed.omitted > 0,
  }
}

export interface ProgressSource {
  listTodos(pid?: string): Promise<TodoItem[]>
  readLog(scope: LogRef['scope'], pid?: string): Promise<{ text: string; error?: string }>
  listEntries(pid?: string): Promise<Entry[]>
  today(): string
  label(): string
  pid?(agent: unknown): Promise<string | undefined>
}

/**
 * Read side: everything comes from the store, nothing is invented. A failed
 * read contributes an error string that the renderer surfaces honestly, so a
 * half-empty report is visibly half-empty.
 */
export async function collectProgress(source: ProgressSource, agent: unknown): Promise<ProgressResult> {
  const pid = await source.pid?.(agent)
  const errors: string[] = []
  const todos = await source.listTodos(pid)
  const logs: ProgressInput['logs'] = []
  for (const scope of (pid === undefined ? (['daily'] as const) : (['project', 'daily'] as const))) {
    const read = await source.readLog(scope, pid)
    if (read.error !== undefined) {
      errors.push(`${scope} log: ${read.error}`)
      logs.push({ scope, text: '', error: read.error })
      continue
    }
    logs.push({ scope, text: read.text })
  }
  const entries = await source.listEntries(pid)
  return renderProgress({
    label: source.label(),
    today: source.today(),
    todos,
    logs,
    entries,
    ...(pid === undefined ? {} : { pid }),
    ...(errors.length === 0 ? {} : { readErrors: errors }),
  })
}
