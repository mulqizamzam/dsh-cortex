/**
 * Handoff Protocol — structured context transfer on session spawn.
 *
 * When an orchestrator spawns a new sub-agent via cortex_session_spawn, the
 * handoff block is prepended to the prompt so the recipient starts with a
 * compact but complete picture of:
 *   - what is happening (summary)
 *   - what has changed (recent log entries)
 *   - what remains to be done (open todos relevant to the task)
 *   - what is blocking progress (blockers section, currently always empty unless
 *     the orchestrator surfaces them in the prompt)
 *
 * The block is generated purely from cortex store reads + the caller's cwd scope;
 * it never invents facts. Every field is neutralized and capped (P2/P9).
 *
 * Config gate: `handoff.enabled` (default false in v1 — opt-in only).
 */
import { clampText, trimToBudget } from '../../../lib/caps.ts'
import { isoDate } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { LogRef, TodoItem } from '../../types.ts'
import { formatTodoLine, orderForDigest } from '../todo/digest.ts'
import { shapeLogText } from '../logs/service.ts'

/** Output ceiling for the whole handoff block (brief enough to prepend). */
export const HANDOFF_BUDGET_CHARS = 2000

/** Log window: 2 days is enough for context without dragging in noise. */
export const HANDOFF_LOG_DAYS = 2

/** Maximum todo lines rendered inside the handoff. */
export const HANDOFF_TODO_LIMIT = 6

/** Maximum log lines per scope inside the handoff. */
export const HANDOFF_LOG_LINES = 10

export interface HandoffInput {
  label: string
  today: string
  /** Open todos scoped to the caller's project (or life/work/daily if no project). */
  todos: TodoItem[]
  /** Per-scope log reads, already labelled by the collector. */
  logs: Array<{ scope: LogRef['scope']; text: string; error?: string }>
  /** Optional free-text the caller wants injected as the blockers section. */
  blockers?: string
  /** Short project marker for the header. */
  projectName?: string
  /** Hard ceiling on the WHOLE block (default: HANDOFF_BUDGET_CHARS). */
  budget?: number
}

export interface HandoffResult {
  /** The assembled block, or '' when budget cannot carry even the label. */
  text: string
  /** True when the block was dropped because the budget was too tight. */
  suppressed: boolean
}

/**
 * Header that identifies the block and its source so a spawned agent knows what
 * it is reading and does not treat it as a direct user instruction.
 */
function handoffLabel(label: string, projectName?: string): string {
  const scope = projectName === undefined || projectName === '' ? '' : ` — ${clampText(neutralize(projectName), 40)}`
  return `## Handoff (dsh-cortex · auto-generated context for spawned session${scope})`
}

function todoBlock(items: TodoItem[], today: string, limit: number): string[] {
  if (items.length === 0) return ['(none)']
  const ordered = orderForDigest(items)
  const shown = ordered.slice(0, limit)
  const omitted = ordered.length - shown.length
  const lines = shown.map(item => formatTodoLine(item, today))
  if (omitted > 0) lines.push(`[… ${String(omitted)} more — see cortex_todo_list]`)
  return lines
}

function logBlock(section: { scope: LogRef['scope']; text: string; error?: string }, maxLines: number): string[] {
  if (section.error !== undefined) return [`log (${section.scope}) — read failed: ${neutralize(section.error)}`]
  const shaped = shapeLogText(section.text)
  if (shaped.lines.length === 0) return [`log (${section.scope}) — nothing recorded`]
  // Newest-last slice (the store is oldest-first; take the tail).
  const tail = shaped.lines.slice(-maxLines).reverse()
  return tail.map(line => `  ${line}`)
}

export function renderHandoff(input: HandoffInput): HandoffResult {
  const budget = Number.isFinite(input.budget) && (input.budget as number) > 0 ? Math.floor(input.budget as number) : HANDOFF_BUDGET_CHARS
  const label = neutralize(input.label)
  const header = handoffLabel(label, input.projectName)

  const lines: string[] = []

  // --- summary (inherited from the task prompt — caller fills this) --------
  // Handoff itself does NOT fabricate a summary; it carries the caller's task
  // description instead. This is left as a placeholder the caller replaces.
  lines.push('### summary')
  lines.push('(see task below)')

  // --- what-changed ----------------------------------------------------------
  lines.push('### what-changed')
  for (const section of input.logs) {
    lines.push(...logBlock(section, HANDOFF_LOG_LINES))
  }
  if (input.logs.length === 0) lines.push('(no log entries)')

  // --- what-remains ----------------------------------------------------------
  lines.push('### what-remains')
  lines.push(...todoBlock(input.todos, input.today, HANDOFF_TODO_LIMIT))

  // --- blockers --------------------------------------------------------------
  lines.push('### blockers')
  if (input.blockers !== undefined && input.blockers.trim() !== '') {
    lines.push(neutralize(input.blockers).split('\n').slice(0, 5).join('\n'))
  } else {
    lines.push('(none surfaced)')
  }

  const framing = `${label}\n${header}`
  if (framing.length + 1 >= budget) {
    return { text: '', suppressed: true }
  }
  const trimmed = trimToBudget(lines, budget - framing.length - 1, {
    separator: '\n',
    omitHint: 'see the Cortex panel',
  })
  const text = `${framing}\n${trimmed.text}`
  if (text.length > budget) return { text: '', suppressed: true }
  return { text, suppressed: false }
}

export interface HandoffSource {
  today(): string
  label(): string
  openTodos(pid?: string): Promise<TodoItem[]>
  readLog(scope: LogRef['scope'], pid?: string): Promise<{ text: string; error?: string }>
  projectName?(): string | undefined
  blockers?(): string | undefined
}

/**
 * Read side: everything comes from the store, nothing is invented. A failed
 * read contributes an error line so the spawned agent sees why a section is empty.
 */
export async function collectHandoff(source: HandoffSource): Promise<HandoffInput> {
  const pid = await (source.projectName === undefined ? undefined : source.projectName())
  const today = source.today()
  const label = source.label()
  const projectName = typeof source.projectName === 'function' ? source.projectName() : undefined
  const blockers = typeof source.blockers === 'function' ? source.blockers() : undefined
  const todos = await source.openTodos(pid ?? undefined)
  const logs: HandoffInput['logs'] = []
  for (const scope of (pid === undefined ? (['daily'] as const) : (['project', 'daily'] as const))) {
    const read = await source.readLog(scope, pid ?? undefined)
    logs.push({ scope, text: read.text, error: read.error })
  }
  return { label, today, todos, logs, projectName, blockers }
}
