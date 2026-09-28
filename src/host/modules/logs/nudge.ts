/**
 * G-06 log review nudge — the honest half of "auto-log".
 *
 * The program does NOT summarise anything and never writes a log line on the
 * user's behalf (DESIGN §9.1 G-06). What it does is count a session's turns
 * and, every `logReview.everyTurns` turns, hand the next prompt assembly one
 * labelled line asking the AI to record what happened. `everyTurns = 0`
 * (the shipped default) keeps the mechanism entirely off.
 *
 * Shape of the state, and why it lives in memory:
 *   - counters are per SESSION id (`agent.id === agent.session.id`, verified in
 *     host `packages/core/agent/src/index.ts:475-478`), because "turns without
 *     a log line" is a property of a conversation, not of a project;
 *   - an armed nudge is a one-shot flag: `take()` returns it and clears it, so
 *     the reminder is delivered exactly once per arming, in the turn AFTER the
 *     one that armed it (that is what "next-turn" means, and re-rendering it
 *     every turn would be nagging, not nudging);
 *   - logging resets the count: the moment a line lands, the debt is paid.
 *
 * Nothing here touches a host API: `countTurn`/`noteLogged`/`take` are plain
 * methods, so the whole mechanism is unit-testable with fake deps.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { ResolvedConfig } from '../../types.ts'

/** Where the interval comes from. Absent until the parent promotes it to config. */
export type LogReviewConfig = { logReview?: { everyTurns?: number } }

/** Read the interval defensively; garbage or absence means OFF (P3). */
export function everyTurnsOf(config: ResolvedConfig & LogReviewConfig): number {
  const raw = config.logReview?.everyTurns
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0
  return Math.floor(raw)
}

/**
 * The one-line ask. Wording per DESIGN §9.1 G-06: the AI is ASKED to record
 * ("AI diminta mencatat"), and the line states plainly that nothing was logged
 * automatically — the program never pretends to have summarised the session.
 */
export function nudgeLine(every: number): string {
  return `## Log review (dsh-cortex — AI diminta mencatat): ${String(every)} turns since the last log line. `
    + 'If this session changed anything worth remembering, record it now with cortex_log_append. Nothing has been logged automatically.'
}

export const NUDGE_CONTEXT_NAME = 'cortex:logs'
/** After the todo digest (41), before rooms (42) is impossible — 42 is taken by
 * M5; the reminder rides at order 44, one past prompts (43). */
export const NUDGE_CONTEXT_ORDER = 44

export interface NudgeState {
  turns: number
  armed: boolean
}

/**
 * Per-session turn counter + one-shot reminder queue.
 * `max` bounds the map: a long-lived host with many finished sessions must not
 * grow without limit, so the least recently used session is dropped.
 */
export class TurnNudge {
  private readonly rows = new Map<string, NudgeState>()

  constructor(
    private readonly every: () => number,
    private readonly maxSessions = 64,
  ) {}

  private row(sessionId: string): NudgeState {
    const existing = this.rows.get(sessionId)
    if (existing !== undefined) return existing
    const created: NudgeState = { turns: 0, armed: false }
    this.rows.set(sessionId, created)
    while (this.rows.size > this.maxSessions) {
      const oldest = this.rows.keys().next()
      if (oldest.done === true) break
      this.rows.delete(oldest.value)
    }
    return created
  }

  /** Interval at call time (config is live; a change takes effect next turn). */
  get interval(): number {
    return this.every()
  }

  /** True when the mechanism is switched on at all. */
  get enabled(): boolean {
    return this.every() > 0
  }

  /**
   * One finished turn for one session. Returns the turn count that armed the
   * nudge, or 0 when nothing armed. A no-op while disabled.
   */
  countTurn(sessionId: string): number {
    const every = this.every()
    if (every <= 0 || sessionId === '') return 0
    const row = this.row(sessionId)
    row.turns += 1
    if (row.turns < every) return 0
    row.turns = 0
    row.armed = true
    return every
  }

  /** A log line landed for this session: the debt is paid, the reminder is off. */
  noteLogged(sessionId: string): void {
    if (sessionId === '') return
    const row = this.row(sessionId)
    row.turns = 0
    row.armed = false
  }

  /** Consume the armed reminder (one shot). Empty string when nothing pending. */
  take(sessionId: string | undefined): string {
    if (sessionId === undefined || sessionId === '') return ''
    const row = this.rows.get(sessionId)
    if (row === undefined || row.armed !== true) return ''
    row.armed = false
    const every = this.every()
    return neutralize(clampText(nudgeLine(every), 600))
  }

  /** Is a reminder waiting for this session? (test seam; does not consume) */
  pending(sessionId: string): boolean {
    return this.rows.get(sessionId)?.armed === true
  }

  /** Turns counted so far for a session (test seam). */
  turnsOf(sessionId: string): number {
    return this.rows.get(sessionId)?.turns ?? 0
  }

  forget(sessionId?: string): void {
    if (sessionId === undefined) this.rows.clear()
    else this.rows.delete(sessionId)
  }
}
