/**
 * The logs service: capped append, bounded read, and the G-06 nudge wiring.
 *
 * Write caps are the store's job (`logAppend` clamps the line to
 * `caps.logLineChars` and rolls the day file at `caps.logDayChars`, DESIGN §3 /
 * P2). What this service adds is scope resolution (a `project` log needs the
 * session's project id — never a guess) and the render-edge sanitisation of
 * everything it reads back out (P9: the store sanitises on write, but a state
 * file may be edited by hand or predate the choke point).
 */
import { clampText } from '../../../lib/caps.ts'
import { isIsoDate, isoDate } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { LogRef, ModuleDeps, ResolvedConfig } from '../../types.ts'
import { NUDGE_CONTEXT_NAME, NUDGE_CONTEXT_ORDER, TurnNudge, everyTurnsOf } from './nudge.ts'
import type { LogReviewConfig } from './nudge.ts'
import { safePid, sharedTaskScopes, cwdOf, sessionIdOf } from '../todo/scope.ts'
import type { TaskScopeCache } from '../todo/scope.ts'
import type { TaskScope } from '../todo/scope.ts'

/** `cortex_log_read` window ceiling (DESIGN §4: lastDays is a small number). */
export const MAX_LAST_DAYS = 7

/** Per-line ceiling on a read-back: the day file can hold 20k chars of history. */
export const READ_LINE_CHARS = 400

/** Lines returned by one read; the panel pages, the model gets a bounded tail. */
export const READ_MAX_LINES = 80

/** Quiet period after a write before the retention sweep runs. */
export const PRUNE_THROTTLE_MS = 5_000

/** One day of a log, as `/dsh-cortex-read` answers it. */
export interface LogDayRow {
  date: string
  text: string
  lines: number
}

export type LogScope = 'project' | 'daily'

export interface LogReadResult {
  ok: boolean
  message: string
  days?: string[]
  text?: string
  lines?: string[]
  /** The store's own joined output, before this service bounded it. */
  raw?: string
}

/**
 * Split a multi-day read into per-day rows (the `logs.read` contract shape).
 * The store labels every chunk it joins as `### <date> (<file>)`, so the split
 * is on OUR OWN marker, and a day with no file simply contributes nothing.
 */
export function rowsByDay(days: readonly string[], joined: string): Array<{ date: string; text: string }> {
  const rows = new Map<string, string[]>()
  let current: string | undefined
  for (const line of joined.split('\n')) {
    const marker = /^### (\d{4}-\d{2}-\d{2}) \(/.exec(line)
    if (marker !== null) {
      current = marker[1]
      rows.set(current as string, [])
      continue
    }
    if (current !== undefined) (rows.get(current) as string[]).push(line)
  }
  const ordered = days.length > 0 ? days : [...rows.keys()]
  return ordered.map(day => ({ date: day, text: (rows.get(day) ?? []).join('\n').trim() }))
}

export interface LogAppendResult {
  ok: boolean
  message: string
  ref?: LogRef
}

type Args = Record<string, unknown>

export interface LogServiceOptions {
  deps: ModuleDeps
  scopes?: TaskScopeCache
  now?: () => Date
  nudge?: TurnNudge
}

/** Service behind `cortex_log_*`, the `logs.read` endpoint and the nudge seam. */
export class LogService {
  readonly deps: ModuleDeps
  readonly scopes: TaskScopeCache
  readonly nudge: TurnNudge
  private readonly clock: () => Date
  private disposers: Array<() => void> = []
  private seamInstalled = false
  /** Pending throttled retention sweep, cleared on teardown. */
  private pruneTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: LogServiceOptions) {
    this.deps = options.deps
    this.scopes = options.scopes ?? sharedTaskScopes()
    this.clock = options.now ?? ((): Date => new Date())
    this.nudge = options.nudge ?? new TurnNudge(() => everyTurnsOf(this.config()))
  }

  get store() {
    return this.deps.store
  }

  config(): ResolvedConfig & LogReviewConfig {
    return this.deps.cfg() as ResolvedConfig & LogReviewConfig
  }

  /** Live interval switch; 0 (default) means the nudge mechanism is off (P3). */
  get everyTurns(): number {
    return this.nudge.interval
  }

  async scopeFor(agent: unknown): Promise<TaskScope> {
    return await this.scopes.resolve(cwdOf(agent))
  }

  /** Today as the store sees it: log day names are local days (`lib/ids`). */
  today(): string {
    return isoDate(this.clock())
  }

  // --------------------------------------------------------------- append ----

  async append(args: Args, agent: unknown): Promise<LogAppendResult> {
    const asked = args.scope
    if (asked !== 'daily' && asked !== 'project') return { ok: false, message: 'scope must be "project" or "daily"' }
    const scope: LogScope = asked
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text === '') return { ok: false, message: 'text is required: one line of what actually happened' }
    let pid: string | undefined
    if (scope === 'project') {
      // A caller-supplied pid is only trusted when it is a store-safe key: the
      // store joins it straight into a path, so anything else is refused here.
      if (args.pid !== undefined && safePid(args.pid) === undefined) {
        return { ok: false, message: 'pid is not a valid project id' }
      }
      const explicit = safePid(args.pid)
      const resolved = await this.scopeFor(agent)
      pid = explicit ?? resolved.pid
      if (pid === undefined) {
        return { ok: false, message: 'a project log needs the session working directory inside a project; use scope "daily" instead' }
      }
    }
    const result = await this.store.logAppend({ scope, text, ...(pid === undefined ? {} : { pid }) })
    if (!result.ok) return { ok: false, message: `could not write the log: ${result.error}` }
    if (pid !== undefined) {
      const cwd = cwdOf(agent)
      await this.store.ensureProject(pid, { ...(cwd === undefined ? {} : { cwd }) })
    }
    // Retention (`retention.dailyLogDays`): the window that used to be a dead
    // config key, now the only thing bounding a log directory. Best-effort —
    // a prune that fails costs disk, never the line just written (P4).
    this.schedulePrune(scope, pid)
    // Recording a line settles the review debt for this session (G-06).
    this.nudge.noteLogged(sessionIdOf(agent) ?? '')
    // A line the rollover limit could not place was NOT logged, and saying
    // otherwise is the failure P4 exists to prevent.
    if (result.data.dropped === true) {
      return { ok: false, message: `the log line was NOT stored: every rollover part for ${result.data.date} is full (caps.logDayChars), so nothing was written. Re-read the log, then retry once the day rolls over.` }
    }
    const rolled = result.data.rolled === true ? ' (day file was full; continued in the next part)' : ''
    return { ok: true, message: `logged to ${scope} ${result.data.date}${rolled}`, ref: result.data }
  }

  /**
   * Prune one log directory to `retention.dailyLogDays`, off the write path.
   *
   * Fire-and-forget with the throttle below: a busy log would otherwise pay a
   * directory listing per appended line, and the window only moves once a day.
   * The timer is unref'd so a pending prune never holds the process open.
   */
  private schedulePrune(scope: 'project' | 'daily', pid?: string): void {
    if (this.pruneTimer !== undefined) return
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined
      void this.prune(scope, pid)
    }, PRUNE_THROTTLE_MS)
    this.pruneTimer.unref?.()
  }

  /** Awaitable prune (mount, tests, shutdown). Never throws. */
  async prune(scope: 'project' | 'daily' = 'daily', pid?: string): Promise<number> {
    const days = this.config().retention.dailyLogDays
    const result = await this.store.pruneLogs({ days, scope, ...(scope === 'project' && pid !== undefined ? { pid } : {}) })
    if (!result.ok) {
      this.deps.warn(`logs: prune (${scope}) failed: ${result.error}`)
      return 0
    }
    if (result.data.removed.length > 0) {
      this.deps.log(`logs: pruned ${String(result.data.removed.length)} log file(s) outside the ${String(days)}-day window`)
    }
    return result.data.removed.length
  }

  // ----------------------------------------------------------------- read ----
  async read(args: Args, agent: unknown): Promise<LogReadResult> {
    const asked = args.scope
    if (asked !== 'daily' && asked !== 'project') return { ok: false, message: 'scope must be "project" or "daily"' }
    const scope: LogScope = asked
    const date = typeof args.date === 'string' ? args.date.trim() : undefined
    if (date !== undefined && !isIsoDate(date)) return { ok: false, message: `date must be YYYY-MM-DD (got "${clampText(date, 40)}")` }
    if (args.lastDays !== undefined && (typeof args.lastDays !== 'number' || !Number.isFinite(args.lastDays))) {
      return { ok: false, message: 'lastDays must be a whole number of days' }
    }
    const rawDays = typeof args.lastDays === 'number' ? Math.floor(args.lastDays) : 1
    if (rawDays > MAX_LAST_DAYS) return { ok: false, message: `lastDays is capped at ${String(MAX_LAST_DAYS)} per call; ask for a specific date for older entries` }
    const lastDays = Math.max(1, rawDays)
    if (args.pid !== undefined && safePid(args.pid) === undefined) return { ok: false, message: 'pid is not a valid project id' }
    const pid = scope === 'daily' ? undefined : (safePid(args.pid) ?? (await this.scopeFor(agent)).pid)
    if (scope === 'project' && pid === undefined) return { ok: false, message: 'a project log needs a project scope; use scope "daily" or work inside a repository' }
    const result = await this.store.logRead({ scope, ...(pid === undefined ? {} : { pid }), ...(date === undefined ? {} : { date }), lastDays })
    if (!result.ok) return { ok: false, message: `could not read the log: ${result.error}` }
    const shaped = shapeLogText(result.data.text)
    return {
      ok: true,
      message: shaped.count === 0 ? `no ${scope} log lines for ${result.data.days.join(', ')}` : `${String(shaped.count)} line(s) across ${String(result.data.days.length)} day file(s)`,
      days: result.data.days,
      text: shaped.text,
      lines: shaped.lines,
      raw: result.data.text,
    }
  }

  /**
   * One bounded read, split into per-day rows for the `logs.read` contract. The
   * day names come from the STORE (`logRead` resolves "today" from the clock
   * that named the files), so a caller can never be answered against a day
   * anchor different from the one that was written.
   */
  async readDays(args: Args, agent: unknown): Promise<{ ok: boolean; message: string; rows: LogDayRow[] }> {
    const result = await this.read(args, agent)
    if (!result.ok) return { ok: false, message: result.message, rows: [] }
    // Split what the store joined instead of reading each day again, then cap
    // each day on its own: a huge day must not starve the others of the budget.
    const rows = rowsByDay(result.days ?? [], result.raw ?? '').map(row => {
      const shaped = shapeLogText(row.text)
      return { date: row.date, text: shaped.text, lines: shaped.count }
    })
    return { ok: true, message: result.message, rows }
  }

  // --------------------------------------------------------------- nudge ----
  /**
   * The `cortex:logs` text provider: a one-shot reminder, consumed the moment
   * it is rendered. Returns '' whenever there is nothing to say (the host
   * omits empty contexts).
   */
  nudgeText = (context: unknown): string => {
    try {
      const config = this.config()
      if (config.inject.enabled !== true || everyTurnsOf(config) <= 0) return ''
      const agent = (context as { agent?: unknown } | undefined)?.agent
      const line = this.nudge.take(sessionIdOf(agent))
      if (line === '') return ''
      return `${neutralize(config.injectLabel)}\n${line}`
    } catch (error) {
      this.deps.warn(`logs: nudge render failed: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** One finished turn for one session (exported seam for the event wiring). */
  turnEnded(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === '') return
    const armed = this.nudge.countTurn(sessionId)
    if (armed > 0) this.deps.log(`logs: review nudge armed for session ${sessionId} (every ${String(armed)} turns)`)
  }

  /** Wire the nudge seam + turn counting. Never throws (P4). */
  install(): void {
    const ctx = this.deps.ctx
    try {
      const prompt = ctx.get('systemPrompt') as { context?: (value: { name: string; order: number; text: (context: unknown) => string }) => unknown } | undefined
      if (typeof prompt?.context !== 'function') {
        this.deps.warn('logs: systemPrompt.context unavailable — log review reminders will not reach the model')
      } else {
        const disposer = prompt.context({ name: NUDGE_CONTEXT_NAME, order: NUDGE_CONTEXT_ORDER, text: this.nudgeText as never })
        this.seamInstalled = true
        if (typeof disposer === 'function') this.disposers.push(disposer as () => void)
      }
    } catch (error) {
      this.deps.warn(`logs: context registration refused: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      // `session/event` is the host's turn firehose; `turn/end` carries the
      // finished turn (host packages/core/agent-loop/src/agent.ts:319).
      const stop = ctx.on('session/event', ((subject: { id?: unknown }, event: { type?: string }) => {
        if (event?.type !== 'turn/end') return
        if (everyTurnsOf(this.config()) <= 0) return
        this.turnEnded(typeof subject?.id === 'string' ? subject.id : sessionIdOf(subject))
      }) as never)
      if (typeof stop === 'function') this.disposers.push(stop as () => void)
    } catch (error) {
      this.deps.warn(`logs: session/event listener refused: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  get hasContextSeam(): boolean {
    return this.seamInstalled
  }

  dispose(): void {
    if (this.pruneTimer !== undefined) {
      clearTimeout(this.pruneTimer)
      this.pruneTimer = undefined
    }
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch {
        // Teardown failures are not ours to propagate (P4).
      }
    }
    this.scopes.forget()
    this.nudge.forget()
  }
}

/**
 * Cap what a read returns: whole lines from the tail (the newest entries are
 * the useful ones), each line clamped, plus an honest count when lines had to
 * be dropped. Never a partial line at the head — the file order is oldest→newest.
 */
export function shapeLogText(raw: string): { lines: string[]; text: string; count: number } {
  const all = raw.split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
  if (all.length === 0) return { lines: [], text: '', count: 0 }
  // Render edge (P9): a stored line is model-visible text.
  const lines = all.slice(-READ_MAX_LINES).map(line => clampText(neutralize(line), READ_LINE_CHARS))
  const dropped = all.length - lines.length
  const shown = dropped > 0 ? [`[… ${String(dropped)} older line(s) omitted — see the Cortex panel]`, ...lines] : lines
  // `### <date> (<file>)` is a section marker the store adds, not a log entry:
  // counting it would inflate the number the message reports.
  const entries = lines.filter(line => !line.startsWith('### ')).length
  return { lines, text: shown.join('\n'), count: entries }
}
