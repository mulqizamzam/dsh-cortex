/**
 * Local memory search: substring + token-overlap scoring, no dependencies, no
 * index (DESIGN §4, `.dev/M0-NOTES.md` §6.9 — the store is index-free, so the
 * listing cap is a real ceiling and the hit list must say so).
 *
 * Snippets are ±160 chars around the first match; the whole rendered answer is
 * capped by `caps.searchResultChars` (P2), by dropping WHOLE hits and appending
 * an honest omission line.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { Entry, Track } from '../../types.ts'

/** Snippet radius around the first match (BRIEFS §M2: "snippet ±160 char"). */
export const SNIPPET_RADIUS = 160

/** Bonus for the whole query appearing verbatim; token hits are worth less. */
const PHRASE_BONUS = 12
const TOKEN_WEIGHT = 3
const TAG_WEIGHT = 2
const ARCHIVED_PENALTY = 1

export interface SearchHit {
  id: string
  track: Track
  snippet: string
  score: number
  branches: string[]
  archived: boolean
}

/** Whitespace/punctuation tokens, lower-cased, deduplicated, ≥2 chars. */
export function tokenize(input: string): string[] {
  const seen = new Set<string>()
  for (const raw of input.toLowerCase().split(/[^a-z0-9_./:-]+/)) {
    const token = raw.trim()
    if (token.length >= 2) seen.add(token)
  }
  return [...seen].slice(0, 32)
}

/**
 * Deterministic relevance: phrase hit, then per-token content overlap, then tag
 * overlap, then importance (G-05: importance + age only, no access scoring).
 * Archive hits rank below an equal active hit.
 */
export function scoreEntry(entry: Entry, query: string, tokens: readonly string[]): number {
  const haystack = `${entry.content} ${entry.tags?.join(' ') ?? ''} ${entry.branches?.join(' ') ?? ''}`.toLowerCase()
  const needle = query.trim().toLowerCase()
  let score = 0
  if (needle !== '' && haystack.includes(needle)) score += PHRASE_BONUS
  const content = entry.content.toLowerCase()
  for (const token of tokens) {
    if (content.includes(token)) score += TOKEN_WEIGHT
    else if (haystack.includes(token)) score += TAG_WEIGHT
  }
  if (score === 0) return 0
  if (entry.archivedAt !== undefined) score -= ARCHIVED_PENALTY
  const importance = Number.isFinite(entry.importance) ? Math.max(1, Math.min(5, entry.importance)) : 3
  return score * 10 + importance
}

/** First index in `text` where the query or any token matches, or -1. */
function firstMatch(text: string, needle: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  if (needle !== '') {
    const at = lower.indexOf(needle)
    if (at >= 0) return at
  }
  for (const token of tokens) {
    const at = lower.indexOf(token)
    if (at >= 0) return at
  }
  return -1
}

/** Windowed snippet with ellipses, whitespace-collapsed, always neutralized. */
export function snippet(text: string, query: string, tokens: readonly string[]): string {
  const flat = clampText(text, SNIPPET_RADIUS * 6)
  const at = firstMatch(flat, query.trim().toLowerCase(), tokens)
  if (at < 0) return neutralize(clampText(flat, SNIPPET_RADIUS * 2))
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(flat.length, at + SNIPPET_RADIUS)
  const head = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''
  return neutralize(`${head}${flat.slice(start, end)}${tail}`)
}

export interface SearchInput {
  entries: readonly Entry[]
  query: string
  /** Hard ceiling on returned hits (the listing cap is a separate honesty note). */
  limit?: number
}

/** Score, drop non-matches, order by score then newest, then cut to `limit`. */
export function searchEntries(input: SearchInput): { hits: SearchHit[]; candidates: number } {
  const query = String(input.query ?? '')
  const tokens = tokenize(query)
  const scored: { entry: Entry; score: number }[] = []
  for (const entry of input.entries) {
    const score = scoreEntry(entry, query, tokens)
    if (score > 0) scored.push({ entry, score })
  }
  const ordered = scored.sort((a, b) =>
    b.score - a.score
    || String(b.entry.createdAt).localeCompare(String(a.entry.createdAt))
    || String(a.entry.id).localeCompare(String(b.entry.id)),
  )
  const limit = Math.max(1, Math.min(input.limit ?? 25, 200))
  const hits: SearchHit[] = ordered.slice(0, limit).map(item => ({
    id: String(item.entry.id),
    track: item.entry.track,
    snippet: snippet(String(item.entry.content ?? ''), query, tokens),
    score: item.score,
    branches: Array.isArray(item.entry.branches) ? item.entry.branches.map(String) : [],
    archived: item.entry.archivedAt !== undefined,
  }))
  return { hits, candidates: ordered.length }
}

/** One hit as a line of model-visible text. */
function hitLine(hit: SearchHit): string {
  const flags = [hit.track, `i${hit.score}`, hit.archived ? 'archived' : null, hit.branches.length > 0 ? `branch:${hit.branches.map(item => neutralize(item)).join(',')}` : null]
    .filter((part): part is string => typeof part === 'string' && part !== '')
  return `- [${neutralize(hit.id)}] (${flags.join(' · ')}) ${hit.snippet}`
}

/**
 * Render hits inside `maxChars`. Whole lines only, plus an honest omission line
 * naming how many hits and how many matches were left out (P2).
 */
export function renderHits(
  hits: readonly SearchHit[],
  options: { maxChars: number; candidates: number; listingTruncated?: boolean },
): { text: string; shown: number; omitted: number } {
  const max = Math.max(0, Math.floor(options.maxChars))
  const notes: string[] = options.listingTruncated === true
    ? ['Note: the entry listing itself hit the 500-entry read cap, so older matches may exist — narrow by track or project.']
    : []
  const lines = hits.map(hitLine)
  const assemble = (kept: number, omittedCount: number): string => {
    const parts = [...notes, ...lines.slice(0, kept)]
    if (omittedCount > 0) parts.push(`[${omittedCount} more match(es) omitted to stay inside the ${max}-char search cap]`)
    return parts.join('\n')
  }
  if (options.candidates === 0) return { text: notes.length > 0 ? notes.join('\n') : 'No memory entries matched.', shown: 0, omitted: 0 }
  if (max === 0) return { text: '', shown: 0, omitted: options.candidates }
  const rest = Math.max(0, options.candidates - lines.length)
  if (assemble(lines.length, rest).length <= max) return { text: assemble(lines.length, rest), shown: lines.length, omitted: rest }
  for (let count = lines.length - 1; count >= 0; count -= 1) {
    const omitted = options.candidates - count
    const candidate = assemble(count, omitted)
    if (candidate.length <= max) return { text: candidate, shown: count, omitted }
  }
  // The cap cannot even hold the omission line: report the smallest honest one.
  const floor = `[0 of ${options.candidates} matches shown — the ${max}-char search cap is too small]`
  return { text: clampText(floor, max), shown: 0, omitted: options.candidates }
}

