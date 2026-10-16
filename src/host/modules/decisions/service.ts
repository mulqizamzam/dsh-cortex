/**
 * Decision service: indexes `[decision]` lines from logs, links decisions to the
 * memory entries they came from, and searches decisions.
 *
 * Linking (the reason this service is more than a parser): when a decision is
 * indexed, the memory store is searched with the decision's own words
 * (context + chosen) and the ids that match are recorded in `linkedEntries`. So
 * a decision answers "which memory is this about?" without the caller having to
 * re-type either side. It is best-effort by design: a failed memory read costs
 * links, never the decision record.
 */
import { clampText } from '../../../lib/caps.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { Decision, Entry, ModuleDeps, Track } from '../../types.ts'
import { searchEntries } from '../memory/search.ts'
import { hasDecisionMarker, parseDecisionLine } from './parser.ts'

/**
 * The marker `store.logRead` appends after cutting its text at
 * `caps.searchResultChars`. Nothing may be parsed past this point.
 */
const TRUNCATION_MARKER = '[… truncated]'

/** How many memory entries one decision may link to. */
export const LINK_LIMIT = 5

/** How many `linkedEntries` may be recorded (auto-linked or manual). */
export const LINK_MAX = 12

/** Ceiling for the rendered list block. */
export const LIST_TEXT_CHARS = 4000

export interface DecisionSearchHit {
  id: string
  context: string
  options: string[]
  chosen: string
  rationale: string
  owner: string
  timestamp: string
  pid?: string
  tags: string[]
  linkedEntries: string[]
  score: number
}

export interface DecisionSearchResult {
  hits: DecisionSearchHit[]
  total: number
  text: string
}

export interface DecisionListResult {
  decisions: Decision[]
  total: number
  text: string
}

export interface IndexResult {
  indexed: number
  skipped: number
  linked: number
  errors: string[]
}

/**
 * Dedup identity of one decision.
 *
 * (context, chosen) alone was too narrow: a re-index must skip the SAME line,
 * but two genuinely different decisions can share a context and a chosen option
 * and differ only in rationale or in the alternatives considered — the second
 * was then discarded as "already stored", silently. Every field here comes from
 * the source line, so a re-index of the same line still yields the same key.
 * `owner` is deliberately excluded: the indexer fills it from the calling
 * session when the line stays silent, so it is not a property of the line.
 */
function decisionKey(decision: Pick<Decision, 'context' | 'options' | 'chosen' | 'rationale'>): string {
  return [decision.context, decision.options.join(','), decision.chosen, decision.rationale]
    .map(part => part.trim().toLowerCase())
    .join('\u0000')
}

/** One decision as a human-readable block; honest about empty fields. */
export function renderDecision(d: Decision): string[] {
  const date = d.timestamp.slice(0, 10)
  const lines = [`- [${d.id}] ${date} — ${clampText(neutralize(d.context), 160)}`]
  const bits: string[] = []
  if (d.options.length > 0) bits.push(`options: ${d.options.length} (${clampText(neutralize(d.options.join(' / ')), 160)})`)
  if (d.chosen !== '') bits.push(`chosen: ${clampText(neutralize(d.chosen), 100)}`)
  if (d.rationale !== '') bits.push(`why: ${clampText(neutralize(d.rationale), 200)}`)
  if (d.owner !== '') bits.push(`owner: ${clampText(neutralize(d.owner), 40)}`)
  if (d.tags.length > 0) bits.push(`tags: ${d.tags.map(t => neutralize(t)).join(',')}`)
  if (d.linkedEntries.length > 0) bits.push(`links: ${String(d.linkedEntries.length)} memory entr${d.linkedEntries.length === 1 ? 'y' : 'ies'}`)
  if (bits.length > 0) lines.push(`  ${bits.join(' · ')}`)
  if (d.linkedEntries.length > 0) lines.push(`  memory: ${d.linkedEntries.map(id => neutralize(id)).join(', ')}`)
  return lines
}

/** Header naming what the block is and how big it got (P1 honest framing). */
export function decisionListHeader(total: number, shown: number): string {
  return `## Decision log (dsh-cortex · stored decision records, newest first; nothing summarised; ${String(total)} total, ${String(shown)} shown)`
}

export class DecisionService {
  constructor(private readonly deps: ModuleDeps) {}
  get store() { return this.deps.store }

  /**
   * Memory entries that a decision could link to, read ONCE per index run.
   *
   * This used to be `findRelatedEntries`, which listed the same entries again
   * for EVERY decision: indexing 40 decisions cost 80 listings, each re-reading
   * every entry file, for links that cannot differ between them — the loop
   * writes decisions, never entries. Best-effort: any failure yields no pool,
   * so no links.
   */
  private async loadLinkPool(pid?: string): Promise<Entry[]> {
    try {
      const scopes: Array<{ track: Track; pid?: string }> = [{ track: 'user' }, { track: 'global' }]
      if (pid !== undefined) scopes.push({ track: 'project', pid })
      const entries: Entry[] = []
      for (const scope of scopes) {
        const result = await this.store.listEntries({ track: scope.track, ...(scope.pid === undefined ? {} : { pid: scope.pid }) })
        if (result.ok) entries.push(...result.data.entries)
      }
      return entries
    } catch {
      return []
    }
  }

  /** Entry ids this decision matches, against an already-read pool. */
  private relatedEntries(decision: Decision, entries: readonly Entry[]): string[] {
    try {
      if (entries.length === 0) return []
      const query = `${decision.context} ${decision.chosen}`.trim()
      if (query === '') return []
      // `searchEntries` never mutates the array it is handed, so one pool is
      // safe to share across every decision of the run.
      const found = searchEntries({ entries, query, limit: LINK_LIMIT })
      return found.hits.map(hit => hit.id).slice(0, LINK_LIMIT)
    } catch {
      return []
    }
  }

  async indexLogLines(args: {
    scope: 'project' | 'daily'
    pid?: string
    lastDays?: number
    owner?: string
    reindex?: boolean
    linkMemories?: boolean
  }): Promise<IndexResult> {
    const result = await this.store.logRead({ scope: args.scope, pid: args.pid, lastDays: args.lastDays ?? 7 })
    if (!result.ok) return { indexed: 0, skipped: 0, linked: 0, errors: [result.error] }
    // `logRead` cuts its text at `caps.searchResultChars` and appends a marker.
    // Splitting that text as if every line were complete both HID decisions past
    // the cut (a clean-looking "found nothing" run) and could store a record
    // composed from a half line, so the marker line is dropped and the run says
    // it was truncated.
    const truncated = result.data.text.includes(TRUNCATION_MARKER)
    const lines = result.data.text
      .split('\n')
      .filter(line => !line.includes(TRUNCATION_MARKER) && hasDecisionMarker(line))
    // Dedup: a re-index must not duplicate what is already stored. Identity is
    // the neutralized (context, chosen) pair — parse is deterministic, so the
    // same source line always yields the same key. `reindex` opts out.
    const known = new Set<string>()
    if (args.reindex !== true) {
      const existing = await this.store.listDecisions({ pid: args.pid, limit: 500 })
      if (existing.ok) {
        for (const d of existing.data) known.add(decisionKey(d))
      }
    }
    let indexed = 0
    let skipped = 0
    let linked = 0
    const errors: string[] = []
    if (truncated) {
      errors.push('the log read was truncated at caps.searchResultChars; any decision line past the cut was not examined (index a shorter window, or raise the cap)')
    }
    // One listing for the whole run; `linkMemories: false` lists nothing at all.
    const linkPool = args.linkMemories === false ? [] : await this.loadLinkPool(args.pid)
    for (const raw of lines) {
      const parsed = parseDecisionLine(raw)
      if (!parsed.ok) { errors.push(parsed.error ?? 'unknown'); continue }
      const base = parsed.decision as Decision
      if (known.has(decisionKey(base))) { skipped += 1; continue }
      // A line that named its own author wins; the calling session only fills
      // the gap, because the indexer is often NOT the session that decided.
      const owner = base.owner !== '' ? base.owner : (args.owner ?? 'user')
      const related = this.relatedEntries(base, linkPool)
      const decision: Decision = {
        ...base,
        owner,
        linkedEntries: related,
        ...(args.pid ? { pid: args.pid } : {}),
      }
      const written = await this.store.addDecision({ id: decision.id, decision })
      if (!written.ok) errors.push(`addDecision(${decision.id}): ${written.error}`)
      else {
        indexed += 1
        linked += related.length
        known.add(decisionKey(decision))
      }
    }
    return { indexed, skipped, linked, errors }
  }

  /**
   * Attach memory entry ids to a stored decision. Manual counterpart to the
   * automatic linking, for the case the words did not match but the operator
   * knows the two are the same thing.
   */
  async link(args: { id: string; entryIds: readonly string[]; pid?: string }): Promise<{ ok: boolean; message: string; decision?: Decision }> {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!isSafeKey(id)) return { ok: false, message: 'id must be a decision id from cortex_decision_list' }
    const current = await this.store.getDecision(id, args.pid)
    if (!current.ok) return { ok: false, message: `could not read decision ${id}: ${current.error}` }
    if (current.data === null) return { ok: false, message: `no stored decision with id ${id} in this scope` }
    const wanted: string[] = []
    for (const raw of args.entryIds) {
      const entryId = typeof raw === 'string' ? raw.trim() : ''
      if (entryId === '' || !isSafeKey(entryId)) continue
      if (!wanted.includes(entryId)) wanted.push(entryId)
    }
    if (wanted.length === 0) return { ok: false, message: 'entryIds must hold at least one memory entry id (from cortex_memory_list)' }
    const merged: string[] = []
    for (const entryId of [...(current.data.linkedEntries ?? []), ...wanted]) {
      if (!merged.includes(entryId)) merged.push(entryId)
      if (merged.length >= LINK_MAX) break
    }
    const updated = await this.store.updateDecision(id, { linkedEntries: merged }, args.pid)
    if (!updated.ok) return { ok: false, message: `could not update decision ${id}: ${updated.error}` }
    if (updated.data === null) return { ok: false, message: `decision ${id} vanished before the link was written` }
    return { ok: true, message: `linked ${String(merged.length)} memory entr${merged.length === 1 ? 'y' : 'ies'} to decision ${id}`, decision: updated.data }
  }

  /** Newest-first decision list, rendered for a human or a model to read. */
  async list(args: { pid?: string; limit?: number } = {}): Promise<DecisionListResult> {
    const stored = await this.store.listDecisions({ pid: args.pid, limit: args.limit ?? 50 })
    if (!stored.ok) return { decisions: [], total: 0, text: `could not read the decision store: ${neutralize(stored.error)}` }
    const shown = stored.data.slice(0, Math.max(1, Math.min(args.limit ?? 50, 200)))
    return {
      decisions: shown,
      total: stored.data.length,
      text: renderDecisionList(shown, stored.data.length),
    }
  }

  async search(args: { query: string; pid?: string; tags?: string[]; limit?: number }): Promise<DecisionSearchResult> {
    const decisions = await this.store.listDecisions({ pid: args.pid, tags: args.tags, limit: args.limit ?? 50 })
    if (!decisions.ok) return { hits: [], total: 0, text: `could not read the decision store: ${neutralize(decisions.error)}` }
    const query = args.query.trim().toLowerCase()
    if (query === '') {
      const hits = decisions.data.map(d => this.hitOf(d))
      return { hits, total: hits.length, text: renderDecisionList(decisions.data, decisions.data.length) }
    }
    const tokens = query.split(/\s+/).filter(Boolean)
    const scored = decisions.data.map(d => {
      let score = 0
      const ctx = d.context.toLowerCase()
      const rat = d.rationale.toLowerCase()
      const cho = d.chosen.toLowerCase()
      const all = `${ctx} ${rat} ${cho} ${(d.tags ?? []).join(' ')}`
      if (all.includes(query)) score += 10
      for (const t of tokens) {
        if (ctx.includes(t)) score += 3
        if (rat.includes(t)) score += 2
        if (cho.includes(t)) score += 2
        if ((d.tags ?? []).some(tag => tag.toLowerCase().includes(t))) score += 1
      }
      return { d, score }
    }).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200))
    const kept = scored.slice(0, limit)
    return {
      hits: kept.map(x => this.hitOf(x.d, x.score)),
      total: scored.length,
      text: renderDecisionList(kept.map(x => x.d), scored.length),
    }
  }

  private hitOf(d: Decision, score = 0): DecisionSearchHit {
    return {
      id: d.id,
      context: neutralize(clampText(d.context, 160)),
      options: (d.options ?? []).map(option => neutralize(clampText(option, 120))),
      chosen: neutralize(clampText(d.chosen, 80)),
      rationale: neutralize(clampText(d.rationale, 200)),
      owner: neutralize(d.owner),
      timestamp: d.timestamp,
      ...(d.pid ? { pid: d.pid } : {}),
      tags: (d.tags ?? []).map(t => neutralize(t)),
      linkedEntries: (d.linkedEntries ?? []).map(entryId => neutralize(entryId)),
      score,
    }
  }
}

/** Render a list of decisions under the honest header, inside a hard budget. */
export function renderDecisionList(decisions: readonly Decision[], total: number): string {
  const header = decisionListHeader(total, decisions.length)
  if (decisions.length === 0) return `${header}\n(nothing recorded — cortex_decision_index_logs parses [decision] lines out of your logs)`
  const lines: string[] = [header]
  for (const d of decisions) lines.push(...renderDecision(d))
  if (total > decisions.length) lines.push(`[… ${String(total - decisions.length)} more not shown — narrow with pid or raise limit]`)
  const text = lines.join('\n')
  return text.length <= LIST_TEXT_CHARS ? text : `${text.slice(0, LIST_TEXT_CHARS - 1)}…`
}

export function decisionService(deps: ModuleDeps): DecisionService {
  return new DecisionService(deps)
}
