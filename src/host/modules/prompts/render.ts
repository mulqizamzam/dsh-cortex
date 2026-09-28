/**
 * M4 · the injection renderer (DESIGN §9.1 G-03 header, §3 caps, P1/P2/P9).
 *
 * Pure: no store, no host, no clock — feed it rows, get text out. Everything the
 * model ever sees from this module is built here, so this is the one file to
 * audit for the rules that matter:
 *
 *  - HONESTY (P1 / G-03): the block leads with the config label, and every
 *    entry header is EXACTLY
 *    `## Saved workflow: <title> (dsh-cortex prompt library — injected on request, <n> rounds left)`.
 *    Imperative wording inside a body is the user's own text; the block never
 *    claims to be a user instruction, never invents a title, and never reports
 *    a round count the queue did not carry.
 *  - BUDGET (P2): one body is clamped per render (`bodyChars`, 2000 default) by
 *    {@link clampBody}, and the whole block — label, headers, bodies, omission
 *    line — is capped at `budget` (4000 default) by dropping WHOLE entries and
 *    saying how many fell out. A budget too small to carry the honest label
 *    contributes nothing: an unlabelled workflow block would be the lie, and
 *    truncating the label is the same lie shorter.
 *  - DEADLINE (BRIEFS §M4): a sticky row that spent its last round is not
 *    silently dropped. It gets ONE final, honest expiry line, then it is gone.
 *
 * Braces (P9 / host issue-class #53): every string assembled here passes
 * `neutralize()`. Rows arrive neutralized from the queue layer; this is the
 * second gate, because a hand-edited `inject/*.json` must not be able to
 * deadlock the session either.
 */
import { clampText, trimToBudget } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import { clampBody, owesExpiry, PROMPTS_BLOCK_CHARS, PROMPT_BODY_CHARS, STICKY_MAX_TURNS } from './queue.ts'
import type { PromptRow } from './queue.ts'

/** One entry header, DESIGN §9.1 G-03 — wording verbatim, count filled in honestly. */
export function workflowHeader(title: string, rounds: number): string {
  const name = clampText(neutralize(title), 80)
  const left = Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : 0
  return `## Saved workflow: ${name === '' ? 'untitled' : name} (dsh-cortex prompt library — injected on request, ${String(left)} rounds left)`
}

/** The single closing line of a sticky row that has spent its window. */
export function expiryHeader(title: string, rounds: number = STICKY_MAX_TURNS): string {
  const name = clampText(neutralize(title), 80)
  const spent = Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : STICKY_MAX_TURNS
  return `## Saved workflow: ${name === '' ? 'untitled' : name} (dsh-cortex prompt library — expired after ${String(spent)} rounds; nothing more is injected for it)`
}

/** One entry: the G-03 header plus the (clamped, neutralized) body. */
export function entryBlock(row: PromptRow, bodyChars: number = PROMPT_BODY_CHARS): string {
  const body = clampBody(neutralize(row.body), positiveOr(bodyChars, PROMPT_BODY_CHARS))
  if (owesExpiry(row)) return expiryHeader(row.title)
  if (body === '') return workflowHeader(row.title, row.rounds)
  return `${workflowHeader(row.title, row.rounds)}\n${body}`
}

export interface RenderInput {
  /** Rows in queue order (the order requests were made). */
  rows: readonly PromptRow[]
  /** The P1 label line, verbatim from `cfg().injectLabel`. */
  label: string
  /** Per-body ceiling; {@link PROMPT_BODY_CHARS} by default. */
  bodyChars?: number
  /** Whole-block ceiling, label included; {@link PROMPTS_BLOCK_CHARS} by default. */
  budget?: number
}

export interface RenderOutput {
  text: string
  /** Rows that ACTUALLY reached the model — the only ones a render may charge. */
  rendered: PromptRow[]
  /** Entries dropped because the block was full. */
  omitted: number
  /** True when the whole block was withheld (the label would not fit). */
  suppressed: boolean
}

const OMIT_HINT = 'more queued prompts did not fit the block — see the Cortex panel'

/**
 * Render the `cortex:prompts` block. `rendered` is the authority for round
 * counters: an entry that did not make it into `text` is NOT charged, which is
 * what "decrement only on actual render" means when the budget is what decided.
 */
export function renderPromptBlock(input: RenderInput): RenderOutput {
  const label = neutralize(String(input.label ?? ''))
  const bodyChars = positiveOr(input.bodyChars, PROMPT_BODY_CHARS)
  const budget = positiveOr(input.budget, PROMPTS_BLOCK_CHARS)
  const rows = [...input.rows]
  const first = rows[0] as PromptRow | undefined
  if (rows.length === 0 || first === undefined) return { text: '', rendered: [], omitted: 0, suppressed: false }
  // Label + at least one real entry must fit. If even that cannot, contribute
  // nothing — and charge nothing: no row reached anyone.
  if (`${label}\n${workflowHeader(first.title, first.rounds)}`.length > budget) {
    return { text: '', rendered: [], omitted: rows.length, suppressed: true }
  }

  const blocks = rows.map(row => entryBlock(row, bodyChars))
  const room = budget - label.length - 1
  const fitted = trimToBudget(blocks, room, { separator: '\n\n', omitHint: OMIT_HINT })
  if (fitted.kept.length === 0) return { text: '', rendered: [], omitted: rows.length, suppressed: false }
  const joined = `${label}\n${fitted.text}`
  return {
    // trimToBudget is exact for whole items; this is the belt-and-braces
    // statement that the ceiling is a ceiling (P2), and the last neutralize.
    text: neutralize(joined.length > budget ? `${joined.slice(0, budget - 1)}…` : joined),
    rendered: rows.slice(0, fitted.kept.length),
    omitted: fitted.omitted,
    suppressed: false,
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
