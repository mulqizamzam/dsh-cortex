/**
 * Parser for `[decision]` tagged log lines.
 *
 * Canonical form: `- [decision] <context> | options: <a, b> | chosen: <a> | rationale: <why>`
 *
 * Flexibility rules (v1 decision log):
 *  - a field may be introduced by any of its aliases, in English or Indonesian
 *    (`chose`, `because`, `alasan`, `keputusan`, …) — see {@link KEY_ALIASES};
 *  - fields are separated by `|` or `;`; a separator INSIDE a value (a rationale
 *    with a pipe) does not split the line, because the scan looks for the next
 *    recognised key, not for the separator;
 *  - markdown emphasis is stripped: `**options:** a, b` parses like `options: a, b`;
 *  - `chosen` is free text when no `options` are given (a decision needs no
 *    menu of alternatives to be a decision);
 *  - when `options` ARE given, `chosen` must match one of them — exactly, or as a
 *    ≥2-character substring either way, which absorbs typos and prefixes. The
 *    "none of the above" family ({@link NONE_VALUES}) is always accepted.
 *
 * Every returned field is neutralized and clamped; a decision line can never
 * inject a template brace pair into model-visible text.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import { newId } from '../../../lib/ids.ts'
import type { Decision, DecisionParseResult } from './types.ts'

const CONTEXT_MAX = 200
const RATIONALE_MAX = 500
const OPTION_MAX_CHARS = 120
const OPTION_MAX_COUNT = 8
const CHOSEN_MAX = 120
const OWNER_MAX = 80
const TAG_MAX = 80
const TAG_MAX_COUNT = 12

/** Accepted field names → canonical field. English and Indonesian aliases. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  context: 'context', konteks: 'context', situation: 'context', situasi: 'context', issue: 'context', problem: 'context',
  options: 'options', opsi: 'options', pilihan: 'options', alternatives: 'options', alternative: 'options', choices: 'options', kandidat: 'options',
  chosen: 'chosen', chose: 'chosen', choose: 'chosen', selected: 'chosen', select: 'chosen', pick: 'chosen', picked: 'chosen',
  decide: 'chosen', decision: 'chosen', keputusan: 'chosen', dipilih: 'chosen', hasil: 'chosen',
  rationale: 'rationale', reason: 'rationale', because: 'rationale', why: 'rationale', alasan: 'rationale', karena: 'rationale',
  owner: 'owner', by: 'owner', pemilik: 'owner', author: 'owner', oleh: 'owner',
  tags: 'tags', tag: 'tags', labels: 'tags', label: 'tags',
}

/** "Rejected everything" values, accepted as `chosen` whatever the options are. */
const NONE_VALUES: readonly string[] = [
  'none', 'none of above', 'none of the above', 'n/a', 'na', 'nothing', 'reject', 'rejected', 'reject all',
  'tidak ada', 'tidak memilih', 'semua ditolak', '-', '—',
]

/** Any known key, optionally wrapped in markdown emphasis, followed by a colon. */
const KEY_PATTERN = new RegExp(
  `(?:^|[|;\\n])\\s*[*_]{0,2}\\s*(${Object.keys(KEY_ALIASES).join('|')})\\s*[*_]{0,2}\\s*:\\s*`,
  'gi',
)

/** Strip markdown emphasis + collapse whitespace; neutralize happens at build. */
function clean(raw: string): string {
  return raw.replace(/[*_`]{1,2}/g, '').replace(/\s+/g, ' ').trim()
}

interface Field {
  name: string
  value: string
}

/**
 * Split the line body into fields. The first recognised key starts the scan;
 * whatever precedes it is the context (unless a `context:` key is present, which
 * then wins). Each value runs until the next recognised key, so a `|` or `;`
 * inside a value survives.
 */
function scanFields(body: string): { lead: string; fields: Field[] } {
  const matches = [...body.matchAll(KEY_PATTERN)]
  if (matches.length === 0) return { lead: body, fields: [] }
  const lead = body.slice(0, matches[0].index ?? 0)
  const fields: Field[] = []
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i] as RegExpExecArray
    const next = matches[i + 1]
    // The value ends where the next key's SEPARATOR starts, so a trailing `|`
    // or `;` is not swallowed into the value.
    const end = next === undefined ? body.length : (next.index ?? body.length)
    const raw = body.slice((match.index ?? 0) + match[0].length, end)
    const name = KEY_ALIASES[String(match[1] ?? '').toLowerCase().trim()]
    if (name === undefined) continue
    fields.push({ name, value: clean(raw.replace(/[|;]\s*$/, '')) })
  }
  return { lead, fields }
}

function splitOptions(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[,/]/)) {
    const cleaned = clampText(neutralize(clean(piece)), OPTION_MAX_CHARS)
    if (cleaned !== '') out.push(cleaned)
    if (out.length >= OPTION_MAX_COUNT) break
  }
  return out
}

function splitTags(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[,\s]+/)) {
    const cleaned = clampText(neutralize(clean(piece)), TAG_MAX)
    if (cleaned !== '' && !out.includes(cleaned)) out.push(cleaned)
    if (out.length >= TAG_MAX_COUNT) break
  }
  return out
}

/** Exact, or a ≥2-character substring in either direction. */
function matchesOption(chosen: string, options: readonly string[]): boolean {
  const needle = chosen.toLowerCase()
  return options.some(option => {
    const hay = option.toLowerCase()
    if (hay === needle) return true
    if (needle.length >= 2 && hay.includes(needle)) return true
    if (hay.length >= 2 && needle.includes(hay)) return true
    return false
  })
}

export function parseDecisionLine(line: string): DecisionParseResult {
  // Leading list dash, quote, blockquote and emphasis markers are all noise.
  const stripped = String(line ?? '').replace(/^[\s>*_#-]+/, '')
  if (!stripped.toLowerCase().startsWith('[decision]')) {
    return { ok: false, error: 'line does not start with [decision]' }
  }
  const body = stripped.slice('[decision]'.length).replace(/^[*_`\s]+/, '')
  if (body.trim() === '') {
    return { ok: false, error: 'decision line has no context' }
  }

  const { lead, fields } = scanFields(body)
  const valueOf = (name: string): string => fields.find(field => field.name === name)?.value ?? ''

  // An explicit `context:` beats the positional lead; otherwise the lead is it.
  const contextRaw = valueOf('context') !== '' ? valueOf('context') : clean(lead)
  if (contextRaw === '') {
    return { ok: false, error: 'decision line has no context' }
  }

  const options = splitOptions(valueOf('options'))
  const chosen = clampText(neutralize(clean(valueOf('chosen'))), CHOSEN_MAX)

  if (chosen !== '' && options.length > 0) {
    const isNone = NONE_VALUES.includes(chosen.toLowerCase())
    if (!isNone && !matchesOption(chosen, options)) {
      return { ok: false, error: 'chosen not in options' }
    }
  }

  const decision: Decision = {
    id: newId(),
    context: clampText(neutralize(contextRaw), CONTEXT_MAX),
    options,
    chosen,
    rationale: clampText(neutralize(valueOf('rationale')), RATIONALE_MAX),
    // A line may name its own author (`owner:` / `by:`); the indexer overrides
    // this with the calling session ONLY when the line stayed silent.
    owner: clampText(neutralize(valueOf('owner')), OWNER_MAX),
    timestamp: new Date().toISOString(),
    tags: splitTags(valueOf('tags')),
    linkedEntries: [],
  }

  return { ok: true, decision }
}
