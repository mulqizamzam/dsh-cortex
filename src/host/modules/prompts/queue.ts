/**
 * M4 · the inject-queue model (DESIGN §2 `inject/<sessionId>.json`, §4
 * `cortex_prompt_inject`, BRIEFS §M4, DESIGN §9.1 G-03/G-05).
 *
 * What lives here and why:
 * - One row = one pending injection for ONE session. Rows are keyed by the
 *   session that will RENDER them, never by the prompt: two sessions injecting
 *   the same saved prompt own separate counters (and one session can never
 *   spend another's rounds — see `inject` in service.ts).
 * - `rounds` is "renders still owed, counting the one happening now": a `once`
 *   row starts at 1 (header: "1 rounds left"), a `sticky` row at
 *   {@link STICKY_MAX_TURNS}. Decrement happens only after a render actually
 *   put the row in front of the model (BRIEFS §M4: "decrement hanya saat
 *   benar-benar dirender"), which is why the row list and the advance step are
 *   separate from the renderer.
 * - A `sticky` row without a deadline is forbidden: at rounds 0 the next
 *   render emits ONE honest expired line and the row is cleared.
 *
 * Shape and the store: the file is the store's own (`store.paths.inject(id)`),
 * read through `store.readInjectQueue` (so a corrupt queue is quarantined, not
 * fatal, P4). The store's `injectPush`/`injectConsume` only model
 * `{promptId, mode, at}` — no round counter, no manual text — so this module
 * writes the WIDER row shape through the same primitive the store uses
 * (`writeJsonAtomic`). Every field is additive to `InjectQueueItem`, and
 * {@link normalizeRows} seeds what it cannot see, so a row pushed by the store
 * API (or by another module) still renders correctly. Precedent for a module
 * writing its own state file inside the root: `modules/rooms/service.ts`.
 */
import { clampText } from '../../../lib/caps.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'

/**
 * Sticky window: renders a row survives before the honest expiry line
 * (BRIEFS §M4: "sticky tanpa batas waktu = tidak boleh", default 25).
 * TODO(PARENT): `PromptsConfig` only carries `enabled`, so the number is a module
 * const here; promote it to `prompts.stickyMaxTurns` (config.ts + schema) and
 * this becomes its fallback instead of its source.
 */
export const STICKY_MAX_TURNS = 25
/** A `once` row is exactly one render. */
export const ONCE_TURNS = 1
/** Ceiling on rows kept for one session (P2: the queue file must stay small). */
export const QUEUE_MAX_ROWS = 8
/**
 * Body budget per row per render (BRIEFS §M4: 2000). TODO(PARENT): `CortexCaps`
 * has no prompt keys — `caps.promptsBodyChars`/`caps.promptsBlockChars` would
 * make this user-tunable like the other render budgets; until then these consts
 * are the hard ceiling the renderer applies.
 */
export const PROMPT_BODY_CHARS = 2000
/** Ceiling on the WHOLE injected block, label and headers included (P2). */
export const PROMPTS_BLOCK_CHARS = 4000
/** Title budget inside a header line. */
export const PROMPT_TITLE_CHARS = 80
/** Ceiling on manual (unsaved) text a caller can push into one queue. */
export const MANUAL_TEXT_CHARS = 2000
/** Header title used by rows that carry manual text instead of a saved prompt. */
export const MANUAL_TITLE = 'manual injection (typed text, not a saved prompt)'

/** One queued injection. */
export interface PromptRow {
  /** Saved prompt this row injects; `''` for a manual-text row. */
  promptId: string
  mode: 'once' | 'sticky'
  /** ISO instant of the moment the row was queued. */
  at: string
  /** Renders still owed, INCLUDING the one happening now. `1..STICKY_MAX_TURNS`. */
  rounds: number
  /** Header title: the saved prompt's title, or {@link MANUAL_TITLE}. */
  title: string
  /** The text to inject (a saved prompt body, clamped; or the manual text). */
  body: string
}

/** The on-disk envelope (the store's `InjectQueue` shape, widened rows). */
export interface PromptQueue {
  sessionId: string
  items: PromptRow[]
  updatedAt: string
}

/**
 * The in-memory queue identity: exactly the file name the store would use, so
 * two session ids that sanitize onto one file can never hold two live queues.
 */
export function safeSessionKey(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown'
}

/** Rounds a freshly queued row of `mode` starts with. */
export function seedRounds(mode: 'once' | 'sticky'): number {
  return mode === 'sticky' ? STICKY_MAX_TURNS : ONCE_TURNS
}

/**
 * Build a row from caller-supplied parts, clamping and neutralizing on the way
 * in: what the queue holds is what a render may show, so nothing past this point
 * has to re-trust the input.
 */
export function makeRow(input: {
  promptId: string
  mode: 'once' | 'sticky'
  title: string
  body: string
  at: string
  rounds?: number
}): PromptRow {
  const rounds = typeof input.rounds === 'number' && Number.isFinite(input.rounds)
    ? Math.max(0, Math.min(STICKY_MAX_TURNS, Math.floor(input.rounds)))
    : seedRounds(input.mode)
  return {
    promptId: isSafeKey(input.promptId) ? input.promptId : '',
    mode: input.mode,
    at: input.at,
    rounds,
    title: clampText(neutralize(input.title), PROMPT_TITLE_CHARS),
    // Newlines are data here (a workflow is usually a list of steps); the store's
    // own clamp flattens, so this edge keeps what it is given, minus braces.
    body: clampBody(neutralize(input.body), PROMPT_BODY_CHARS),
  }
}

/** Line-aware clamp: keeps whole leading lines, then one honest marker. */
export function clampBody(input: string, max: number): string {
  const limit = Math.max(0, Math.floor(max))
  if (input.length <= limit) return input
  if (limit === 0) return ''
  const marker = ' [… body clamped]'
  const room = Math.max(0, limit - marker.length)
  const lines = input.split('\n')
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const extra = used === 0 ? line.length : line.length + 1
    if (used + extra > room) break
    kept.push(line)
    used += extra
  }
  if (kept.length === 0) return `${input.slice(0, room)}${marker}`
  return `${kept.join('\n')}${marker}`
}

/**
 * Tolerant read of whatever a queue file holds (P4): garbage, a store-shaped row
 * with no round counter, or a hand-edited row with no body all come back as
 * either a usable row or nothing — never a throw, and never a render of text the
 * store did not give us.
 *
 * A row that names a prompt but carries no body is KEPT: the library is the
 * authority for its text and `prime()` hydrates it. Only a row with nothing to
 * hydrate from (no prompt, no body) is dropped, because it could only ever
 * render a header over an empty block.
 */
export function normalizeRows(value: unknown): PromptRow[] {
  const items = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : []
  const rows: PromptRow[] = []
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const mode = row.mode === 'sticky' ? 'sticky' : row.mode === 'once' ? 'once' : undefined
    if (mode === undefined) continue
    const promptId = typeof row.promptId === 'string' && isSafeKey(row.promptId) ? row.promptId : ''
    const at = typeof row.at === 'string' ? row.at : ''
    const body = typeof row.body === 'string' ? row.body : typeof row.text === 'string' ? row.text : ''
    if (promptId === '' && body.trim() === '') continue
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title : promptId === '' ? MANUAL_TITLE : promptId
    const seeded = typeof row.rounds === 'number' && Number.isFinite(row.rounds)
      ? Math.max(0, Math.min(STICKY_MAX_TURNS, Math.floor(row.rounds)))
      : seedRounds(mode)
    rows.push({
      promptId,
      mode,
      at,
      rounds: seeded,
      title: clampText(neutralize(title), PROMPT_TITLE_CHARS),
      body: clampBody(neutralize(body), PROMPT_BODY_CHARS),
    })
  }
  return rows.slice(0, QUEUE_MAX_ROWS)
}

/** The envelope written to `inject/<sessionId>.json`. */
export function queueFile(sessionId: string, rows: readonly PromptRow[], at: string): PromptQueue {
  return { sessionId, items: [...rows], updatedAt: at }
}

/**
 * Advance the queue after a render: rows the renderer did NOT put on screen are
 * untouched (an omitted row keeps every one of its rounds), rendered rows lose
 * one, a spent `once` row is gone, and a spent `sticky` row survives exactly
 * long enough to say it expired.
 *
 * Rows are matched by object identity, which is what `renderPromptBlock`
 * returns (it slices the array it was handed). Identity is the honest key: two
 * identical manual-text rows queued in the same instant are still two rows.
 */
export function advanceRows(rows: readonly PromptRow[], rendered: readonly PromptRow[]): PromptRow[] {
  const spent = new Set<PromptRow>(rendered)
  const next: PromptRow[] = []
  for (const row of rows) {
    if (!spent.has(row)) {
      next.push(row)
      continue
    }
    const left = row.rounds - 1
    if (left > 0) {
      next.push({ ...row, rounds: left })
      continue
    }
    if (row.mode === 'sticky' && row.rounds > 0) next.push({ ...row, rounds: 0 })
    // `once` at rounds 1, or a sticky row that already said 'expired': dropped.
  }
  return next.slice(0, QUEUE_MAX_ROWS)
}

/** True when a sticky row is sitting at 0 rounds, i.e. it owes the expiry line. */
export function owesExpiry(row: PromptRow): boolean {
  return row.mode === 'sticky' && row.rounds <= 0
}
