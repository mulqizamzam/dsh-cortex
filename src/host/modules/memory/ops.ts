/**
 * Memory operations, shared by the agent tools and the RPC endpoints so the two
 * surfaces cannot drift: one rule set, two doors.
 *
 * Every function validates its own arguments — nothing here trusts a caller —
 * and nothing here throws. Bad input comes back as `{ ok:false, error }` and a
 * failure message is always model-visible text, hence neutralized (P3/P4/P9).
 */
import { clampText } from '../../../lib/caps.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import { LIST_CAP } from '../../store.ts'
import type { CortexStore } from '../../store.ts'
import { capBlock } from './render.ts'
import type { Entry, PendingItem, ResolvedConfig, Track } from '../../types.ts'
import type { ScopeCache } from './scope.ts'
import { renderHits, searchEntries } from './search.ts'
import type { SearchHit } from './search.ts'

export const TRACK_VALUES: readonly Track[] = ['user', 'global', 'project']

/** Result of one operation: a value, or a message that is safe to show. */
export type OpResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

export function ok<T>(value: T): OpResult<T> {
  return { ok: true, value }
}

export function fail(error: string, code?: string): OpResult<never> {
  return { ok: false, error: neutralize(error), ...(code === undefined ? {} : { code }) }
}

/** Everything an operation needs; one object so tools and RPC pass the same. */
export interface MemoryContext {
  config: ResolvedConfig
  store: CortexStore
  scopes: ScopeCache
  /** Single-use tokens for the two-step delete, shared with the tool surface. */
  tokens: ConfirmTokens
  /** sessionId → cwd, when the host can say (RPC payloads carry session ids). */
  sessionCwd?(sessionId: string): string | undefined
}

/** Op inputs come from a model or a browser: narrow everything by hand. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function isFail(value: unknown): value is { ok: false; error: string; code?: string } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

type Parsed<T> = { ok: true; value: T } | OpResult<never>

function parseString(input: unknown, field: string, options: { max?: number; required?: boolean } = {}): Parsed<string | undefined> {
  if (input === undefined || input === null || input === '') {
    if (options.required === true) return fail(`${field} is required and must be a non-empty string`)
    return ok(undefined)
  }
  if (typeof input !== 'string') return fail(`${field} must be a string`)
  const value = input.trim()
  if (value === '') return options.required === true ? fail(`${field} must not be empty`) : ok(undefined)
  return ok(options.max === undefined ? value : clampText(value, options.max))
}

function parseNumber(input: unknown, field: string, min: number, max: number): Parsed<number | undefined> {
  if (input === undefined || input === null || input === '') return ok(undefined)
  const value = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(value)) return fail(`${field} must be a number`)
  return ok(Math.max(min, Math.min(max, Math.round(value))))
}

function parseList(input: unknown, field: string, maxItems: number): Parsed<string[] | undefined> {
  if (input === undefined || input === null) return ok(undefined)
  if (!Array.isArray(input)) return fail(`${field} must be an array of strings`)
  const out: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') return fail(`${field} must contain only strings`)
    const value = item.trim()
    if (value !== '') out.push(clampText(value, 80))
  }
  return ok(out.slice(0, maxItems))
}

function parseTrack(input: unknown, field = 'track'): Parsed<Track> {
  if (typeof input !== 'string' || !TRACK_VALUES.includes(input as Track)) return fail(`${field} must be one of: ${TRACK_VALUES.join(', ')}`)
  return ok(input as Track)
}

/** One optional string, read from `payload.x` or `payload.scope.x`. */
function scopeString(payload: Record<string, unknown>, key: 'cwd' | 'projectId' | 'sessionId'): string | undefined {
  const scope = asRecord(payload.scope)
  const direct = payload[key] ?? scope[key]
  return typeof direct === 'string' && direct.trim() !== '' ? direct.trim() : undefined
}

export interface CallScope {
  pid?: string
  branch: string | null
  cwd?: string
  sessionId?: string
  remoteUrl?: string
  repoRoot?: string
}

/**
 * Project + branch for one call: an explicit `projectId` wins, otherwise the
 * live git scope of the caller's cwd (memoised, so this is cheap per turn).
 * No cwd, no project: `pid` stays undefined and only user/global tracks exist.
 */
export async function projectForCall(context: MemoryContext, payload: Record<string, unknown>): Promise<CallScope> {
  const sessionId = scopeString(payload, 'sessionId')
  const cwd = scopeString(payload, 'cwd') ?? (sessionId !== undefined && context.sessionCwd !== undefined ? context.sessionCwd(sessionId) : undefined)
  const explicit = scopeString(payload, 'projectId')
  if (explicit !== undefined && !isSafeKey(explicit)) return { branch: null, ...(cwd ? { cwd } : {}), ...(sessionId ? { sessionId } : {}) }
  const scope = await context.scopes.resolve(cwd)
  return {
    pid: explicit ?? scope.pid,
    branch: scope.branch,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(scope.remoteUrl !== undefined ? { remoteUrl: scope.remoteUrl } : {}),
    ...(scope.root !== undefined ? { repoRoot: scope.root } : {}),
  }
}

/**
 * Record `projects/<pid>/meta.json` for a project we are about to write into
 * (DESIGN §2). The entry write does not depend on it, so a failure here is
 * ignored rather than turning a successful store into an error.
 */
async function noteProject(context: MemoryContext, scope: CallScope): Promise<void> {
  if (scope.pid === undefined) return
  await context.store.ensureProject(scope.pid, {
    ...(scope.remoteUrl !== undefined ? { remoteUrl: scope.remoteUrl } : {}),
    ...(scope.repoRoot !== undefined ? { cwd: scope.repoRoot } : {}),
  })
}

export interface RememberArgs {
  track?: unknown
  content?: unknown
  importance?: unknown
  tags?: unknown
  branches?: unknown
  reason?: unknown
  scope?: unknown
  projectId?: unknown
  cwd?: unknown
  sessionId?: unknown
}

export interface RememberResult {
  accepted: 'pending' | 'stored'
  id: string
  track: Track
  content: string
  clamped: boolean
  autoAccept: boolean
  note: string
}

/**
 * `cortex_memory_remember`. The gate is the whole point (P3, DESIGN §4): an
 * AI-authored memory becomes a PENDING PROPOSAL unless `memory.autoAccept` is
 * on; only that config turns it into a real entry, and then with
 * `origin:'ai-confirmed'` so the record says who wrote it (C-03).
 */
export async function remember(context: MemoryContext, args: RememberArgs): Promise<OpResult<RememberResult>> {
  const config = context.config
  const wanted = parseTrack(args.track)
  if (isFail(wanted)) return wanted
  const content = parseString(args.content, 'content', { required: true })
  if (isFail(content)) return content
  const importance = parseNumber(args.importance, 'importance', 1, 5)
  if (isFail(importance)) return importance
  const tags = parseList(args.tags, 'tags', 12)
  if (isFail(tags)) return tags
  const branches = parseList(args.branches, 'branches', 12)
  if (isFail(branches)) return branches
  const reason = parseString(args.reason, 'reason', { max: 300 })
  if (isFail(reason)) return reason

  const payload = asRecord(args)
  const scope = await projectForCall(context, payload)
  const text = String(content.value ?? '')
  const budget = Math.max(1, Math.floor(config.caps.entryChars))
  const stored = clampText(text, budget)
  const clamped = stored !== text
  if (wanted.value === 'project' && !scope.pid) {
    return fail('no project could be resolved for this call, so a project-track memory cannot be placed; pass scope.cwd/scope.projectId or use track global')
  }

  if (wanted.value === 'project') await noteProject(context, scope)
  if (config.memory.autoAccept !== true) {
    const proposal: PendingItem['proposal'] = {
      track: wanted.value,
      content: stored,
      ...(importance.value !== undefined ? { importance: importance.value } : {}),
      ...(tags.value !== undefined ? { tags: tags.value } : {}),
      ...(branches.value !== undefined ? { branches: branches.value } : {}),
    }
    const added = await context.store.addPending({
      kind: 'memory',
      proposal,
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
      ...(scope.sessionId !== undefined ? { fromSessionId: scope.sessionId } : {}),
    })
    if (!added.ok) return fail(added.error, 'write-failed')
    return ok({
      accepted: 'pending',
      id: added.data.id,
      track: wanted.value,
      // What the store actually kept (it sanitises on write), not what we sent.
      content: neutralize(String(added.data.proposal.content ?? stored)),
      clamped,
      autoAccept: false,
      note: `Queued as a proposal (pending/${added.data.id}); it is NOT memory yet. The user approves or rejects it in the Cortex panel.${clamped ? ` Text was clamped to ${budget} chars.` : ''}`,
    })
  }

  const added = await context.store.addEntry({
    scope: { track: wanted.value, ...(wanted.value === 'project' ? { pid: scope.pid } : {}) },
    content: stored,
    ...(importance.value !== undefined ? { importance: importance.value } : {}),
    ...(tags.value !== undefined ? { tags: tags.value } : {}),
    ...(branches.value !== undefined && branches.value.length > 0 ? { branches: branches.value } : {}),
    origin: 'ai-confirmed',
    ...(scope.sessionId !== undefined ? { source: { sessionId: scope.sessionId } } : {}),
  })
  if (!added.ok) return fail(added.error, 'write-failed')
  return ok({
    accepted: 'stored',
    id: added.data.id,
    track: wanted.value,
    content: added.data.content,
    clamped,
    autoAccept: true,
    note: `Stored directly (origin ai-confirmed) because memory.autoAccept is on.${clamped ? ` Text was clamped to ${budget} chars.` : ''}`,
  })
}

export interface SearchArgs {
  query?: unknown
  tracks?: unknown
  project?: unknown
  includeArchive?: unknown
  limit?: unknown
  scope?: unknown
}

export interface SearchResult {
  text: string
  hits: SearchHit[]
  shown: number
  omitted: number
  candidates: number
  listingTruncated: boolean
}

/**
 * `cortex_memory_search` / `memory.search`: scans the active entries of the
 * chosen tracks (+ archive when asked) and renders inside
 * `caps.searchResultChars`.
 */
export async function search(context: MemoryContext, args: SearchArgs): Promise<OpResult<SearchResult>> {
  const query = parseString(args.query, 'query', { required: true, max: 200 })
  if (isFail(query)) return query
  const scope = await projectForCall(context, asRecord(args))
  const limit = parseNumber(args.limit, 'limit', 1, 200)
  if (isFail(limit)) return limit

  let wanted: Track[] = ['user', 'global', 'project']
  if (args.tracks !== undefined && args.tracks !== null) {
    const raw = Array.isArray(args.tracks) ? args.tracks : [args.tracks]
    const parsed: Track[] = []
    for (const item of raw) {
      const value = parseTrack(item, 'tracks entry')
      if (isFail(value)) return value
      if (!parsed.includes(value.value)) parsed.push(value.value)
    }
    if (parsed.length === 0) return fail(`tracks must name at least one of: ${TRACK_VALUES.join(', ')}`)
    wanted = parsed
  }
  if (args.project === false) wanted = wanted.filter(item => item !== 'project')
  if (typeof args.project === 'string' && args.project.trim() !== '') {
    if (!isSafeKey(args.project.trim())) return fail('project must be true, false, or a project id')
    wanted = [...new Set<Track>([...wanted, 'project'])]
    scope.pid = args.project.trim()
  }
  const includeArchive = args.includeArchive === true

  const entries: Entry[] = []
  let listingTruncated = false
  for (const track of wanted) {
    if (track === 'project' && !scope.pid) continue
    const pages: boolean[] = includeArchive ? [false, true] : [false]
    for (const archived of pages) {
      const result = await context.store.listEntries({
        track,
        ...(track === 'project' ? { pid: scope.pid } : {}),
        ...(archived ? { archived: true } : {}),
      })
      if (!result.ok) return fail(result.error, 'read-failed')
      entries.push(...result.data.entries)
      listingTruncated = listingTruncated || result.data.truncated
    }
  }

  const found = searchEntries({ entries, query: String(query.value ?? ''), ...(limit.value !== undefined ? { limit: limit.value } : {}) })
  const rendered = renderHits(found.hits, {
    maxChars: context.config.caps.searchResultChars,
    candidates: found.candidates,
    listingTruncated,
  })
  return ok({
    text: rendered.text,
    hits: neutralizeDeep(found.hits),
    shown: rendered.shown,
    omitted: rendered.omitted,
    candidates: found.candidates,
    listingTruncated,
  })
}

export interface ListArgs {
  track?: unknown
  branchOnly?: unknown
  archived?: unknown
  limit?: unknown
  scope?: unknown
  /** Explicit branch for the scope filter; `null` = unknown, absent = live. */
  branch?: unknown
}

export interface ListResult {
  text: string
  entries: Entry[]
  truncated: boolean
  branch: string | null
  pid?: string
}

/** `cortex_memory_list` / `memory.list`: raw entries, capped and honestly headed. */
export async function listEntries(context: MemoryContext, args: ListArgs): Promise<OpResult<ListResult>> {
  const payload = asRecord(args)
  const scope = await projectForCall(context, payload)
  let wanted: Track | undefined
  if (args.track !== undefined && args.track !== null && args.track !== '') {
    const value = parseTrack(args.track)
    if (isFail(value)) return value
    wanted = value.value
  }
  const limit = parseNumber(args.limit, 'limit', 1, LIST_CAP)
  if (isFail(limit)) return limit
  const archived = args.archived === true
  const branchOnly = args.branchOnly === true
  // An explicit branch (the RPC contract's `branch` argument) wins over the
  // live one; `null` means "unknown", which shows unscoped entries only (P8).
  const asked = args.branch === undefined ? undefined : args.branch === null ? null : typeof args.branch === 'string' ? args.branch.trim() : undefined
  if (args.branch !== undefined && asked === undefined) return fail('branch must be a string or null')
  const filterBranch = asked !== undefined ? asked : branchOnly ? scope.branch : undefined

  const result = await context.store.listEntries({
    ...(wanted !== undefined ? { track: wanted } : {}),
    ...(wanted === undefined || wanted === 'project' ? { pid: scope.pid } : {}),
    ...(archived ? { archived: true } : {}),
    // `branchOnly` means "what actually shows on this branch"; a plain listing
    // must also show branch-scoped entries, or the panel hides data (P2 honesty).
    ...(filterBranch !== undefined ? { branch: filterBranch } : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
  })
  if (!result.ok) return fail(result.error, 'read-failed')
  const shown = result.data.entries
  const scopedNote = filterBranch !== undefined
    ? `branch ${filterBranch === null || filterBranch === '' ? 'unknown (unscoped only)' : filterBranch}`
    : 'all branch scopes'
  const header = `${shown.length} ${archived ? 'archived ' : ''}entries · ${scopedNote}${wanted === undefined ? '' : ` · track ${wanted}`}`
  const lines = shown.map(entry => {
    const bits = [entry.track, `i${entry.importance}`]
    if (entry.archivedAt !== undefined) bits.push('archived')
    if (Array.isArray(entry.branches) && entry.branches.length > 0) bits.push(`branch:${entry.branches.join(',')}`)
    return `- [${entry.id}] (${bits.join(' · ')}) ${clampText(entry.content, 160)}`
  })
  const capped = shown.length >= LIST_CAP || result.data.truncated === true
  const body = [header, ...(lines.length === 0 ? ['(nothing stored yet)'] : lines), ...(capped ? [`[listing capped at ${LIST_CAP} entries per track — narrow with cortex_memory_search]`] : [])].join('\n')
  return ok({
    text: neutralize(capBlock(body, context.config.caps.searchResultChars)),
    entries: neutralizeDeep(shown),
    truncated: capped || result.data.truncated === true,
    branch: scope.branch,
    ...(scope.pid !== undefined ? { pid: scope.pid } : {}),
  })
}

export interface UpdateArgs {
  id?: unknown
  content?: unknown
  importance?: unknown
  tags?: unknown
  branches?: unknown
  scope?: unknown
}

/** Id-addressed update (C-05): no text matching, so nothing can hit a twin. */
export async function updateEntry(context: MemoryContext, args: UpdateArgs): Promise<OpResult<Entry>> {
  const id = parseString(args.id, 'id', { required: true })
  if (isFail(id)) return id
  if (!isSafeKey(String(id.value))) return fail('id must be an entry id (12 hex chars)', 'bad-id')
  const content = parseString(args.content, 'content', { max: context.config.caps.entryChars })
  if (isFail(content)) return content
  const importance = parseNumber(args.importance, 'importance', 1, 5)
  if (isFail(importance)) return importance
  const tags = parseList(args.tags, 'tags', 12)
  if (isFail(tags)) return tags
  const branches = parseList(args.branches, 'branches', 12)
  if (isFail(branches)) return branches
  if (content.value === undefined && importance.value === undefined && tags.value === undefined && branches.value === undefined) {
    return fail('nothing to update: pass at least one of content, importance, tags, branches')
  }
  const scope = await projectForCall(context, asRecord(args))
  const result = await context.store.updateEntry(String(id.value), {
    ...(content.value !== undefined ? { content: content.value } : {}),
    ...(importance.value !== undefined ? { importance: importance.value } : {}),
    ...(tags.value !== undefined ? { tags: tags.value } : {}),
    ...(branches.value !== undefined ? { branches: branches.value } : {}),
    ...(scope.pid !== undefined ? { pid: scope.pid } : {}),
  })
  if (!result.ok) return fail(result.error, 'write-failed')
  if (result.data === null) return fail(`no memory entry with id ${id.value} in the user, global or this project track`, 'not-found')
  return ok(neutralizeDeep(result.data) as Entry)
}

/** One-shot token for a destructive step: short-lived, in-memory, bound to a key. */
export class ConfirmTokens {
  private readonly rows = new Map<string, { at: number; key: string }>()

  constructor(private readonly ttlMs = 5 * 60_000, private readonly clock: () => number = () => Date.now()) {}

  issue(key: string): string {
    this.prune()
    const token = `cf_${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 8)}`
    this.rows.set(token, { at: this.clock(), key })
    return token
  }

  /** True once per token; expired or wrong-key tokens never pass. */
  consume(token: string, key: string): boolean {
    this.prune()
    const row = this.rows.get(token)
    if (row === undefined) return false
    this.rows.delete(token)
    return row.key === key
  }

  get size(): number {
    return this.rows.size
  }

  private prune(): void {
    const now = this.clock()
    for (const [token, row] of this.rows) if (now - row.at > this.ttlMs) this.rows.delete(token)
  }
}

export interface DeleteArgs {
  id?: unknown
  confirm?: unknown
  scope?: unknown
}

export interface DeleteResult {
  deleted: boolean
  token?: string
  warning?: string
}

/**
 * `cortex_memory_delete`: always two steps. The first names the exact entry and
 * returns a single-use token; the second presents it. Deletion happens ONLY when
 * the second call presents the exact token the first call issued (bound to this
 * id) — any other value (a guess, the old frozen literal, an empty string, a
 * reused or expired token) is refused. The browser UI drives the same two steps:
 * it calls once to get the token, then again with it.
 */
export async function deleteEntry(
  context: MemoryContext,
  args: DeleteArgs,
  tokens: ConfirmTokens,
): Promise<OpResult<DeleteResult>> {
  const id = parseString(args.id, 'id', { required: true })
  if (isFail(id)) return id
  if (!isSafeKey(String(id.value))) return fail('id must be an entry id (12 hex chars)', 'bad-id')
  const scope = await projectForCall(context, asRecord(args))
  const listing = await context.store.listEntries({ ...(scope.pid !== undefined ? { pid: scope.pid } : {}), archived: true, limit: LIST_CAP })
  const active = await context.store.listEntries({ ...(scope.pid !== undefined ? { pid: scope.pid } : {}), limit: LIST_CAP })
  if (!listing.ok && !active.ok) return fail(listing.error, 'read-failed')
  const found = [...(active.ok ? active.data.entries : []), ...(listing.ok ? listing.data.entries : [])].find(entry => entry.id === id.value)
  const key = `delete:${String(id.value)}`
  const confirm = typeof args.confirm === 'string' ? args.confirm.trim() : ''
  if (confirm === '') {
    // First step: hand back a single-use token; delete nothing yet.
    const token = tokens.issue(key)
    const warning = found === undefined
      ? `Nothing matched id ${id.value}, so this call can delete nothing. It returned the token ${token} only so the two-step shape stays uniform; re-run with confirm to see the not-found error.`
      : `About to permanently delete entry [${found.id}] (${found.track}${found.archivedAt !== undefined ? ', archived' : ''}): "${clampText(found.content, 160)}". Call again with confirm="${token}" to do it; the token works once, for this id only.`
    return ok({ deleted: false, token, warning: neutralize(warning) })
  }
  // Second step: the ONLY value that deletes is the exact issued token. A guess,
  // the old frozen literal, an empty string, or a reused token all fail here.
  if (!tokens.consume(confirm, key)) {
    return fail(`confirm "${confirm}" is not the single-use token issued for this id: tokens are single-use, expire after 5 minutes and only delete the entry they name. Call without confirm to get a fresh one.`, 'bad-confirm')
  }
  const removed = await context.store.deleteEntry(String(id.value), scope.pid)
  if (!removed.ok) return fail(removed.error, 'write-failed')
  if (removed.data !== true) return fail(`no memory entry with id ${id.value} to delete`, 'not-found')
  return ok({ deleted: true })
}

/** Archive / restore: id-addressed, project-hinted, honest when nothing matched. */
export async function moveEntry(
  context: MemoryContext,
  args: { id?: unknown; scope?: unknown },
  action: 'archive' | 'restore',
): Promise<OpResult<Entry>> {
  const id = parseString(args.id, 'id', { required: true })
  if (isFail(id)) return id
  if (!isSafeKey(String(id.value))) return fail('id must be an entry id (12 hex chars)', 'bad-id')
  const scope = await projectForCall(context, asRecord(args))
  const result = action === 'archive'
    ? await context.store.archiveEntry(String(id.value), scope.pid)
    : await context.store.restoreEntry(String(id.value), scope.pid)
  if (!result.ok) return fail(result.error, 'write-failed')
  if (result.data === null) {
    return fail(`no ${action === 'archive' ? 'active' : 'archived'} entry with id ${id.value} in the user, global or this project track${action === 'restore' ? ' (restore needs the id of an archived entry: list with archived:true)' : ''}`, 'not-found')
  }
  return ok(neutralizeDeep(result.data) as Entry)
}

/**
 * Approve one pending MEMORY proposal: the only route by which AI-proposed text
 * becomes memory when autoAccept is off (C-03). The store call for the decision
 * is `approvePending`; a non-memory proposal is refused, not silently applied.
 */
export async function approvePendingMemory(context: MemoryContext, args: { id?: unknown; scope?: unknown }): Promise<OpResult<{ pendingId: string; entryId: string; track: Track }>> {
  const id = parseString(args.id, 'id', { required: true })
  if (isFail(id)) return id
  if (!isSafeKey(String(id.value))) return fail('id must be a pending-item id', 'bad-id')
  const pending = await context.store.listPending({ status: 'pending', limit: LIST_CAP })
  if (!pending.ok) return fail(pending.error, 'read-failed')
  const item = pending.data.find(row => row.id === id.value)
  if (item === undefined) return fail(`no pending proposal with id ${id.value} (it may already be decided)`, 'not-found')
  if (item.kind !== 'memory') return fail(`pending/${id.value} is a "${item.kind}" proposal; the memory module approves memory proposals only`, 'wrong-kind')
  const proposal = item.proposal ?? {}
  const wanted = parseTrack(proposal.track ?? 'global', 'proposal.track')
  if (isFail(wanted)) return wanted
  const content = parseString(proposal.content, 'proposal.content', { required: true, max: context.config.caps.entryChars })
  if (isFail(content)) return content
  // Parent integration (types: PendingItem.proposal.pid): when a project-scoped
  // proposal carries its own pid and the caller did not re-supply a scope, trust
  // the stored pid so the panel can approve without knowing the cwd. An explicit
  // args projectId still wins (existing behaviour + tests unchanged).
  const argsRecord = asRecord(args)
  if (wanted.value === 'project' && argsRecord.projectId === undefined && typeof proposal.pid === 'string' && isSafeKey(proposal.pid)) {
    argsRecord.projectId = proposal.pid
  }
  const scope = await projectForCall(context, argsRecord)
  if (wanted.value === 'project' && !scope.pid) return fail('this proposal is project-scoped but no project is in scope now; approve it from the project it belongs to')
  if (wanted.value === 'project') await noteProject(context, scope)
  const added = await context.store.addEntry({
    scope: { track: wanted.value, ...(wanted.value === 'project' ? { pid: scope.pid } : {}) },
    content: String(content.value),
    ...(proposal.importance !== undefined ? { importance: proposal.importance } : {}),
    ...(Array.isArray(proposal.tags) ? { tags: proposal.tags } : {}),
    ...(Array.isArray(proposal.branches) ? { branches: proposal.branches } : {}),
    // Who wrote it: a proposal from a session is AI-authored, otherwise UI/user.
    origin: item.fromSessionId === undefined ? 'user' : 'ai-confirmed',
    ...(item.fromSessionId !== undefined ? { source: { sessionId: item.fromSessionId, quote: clampText(String(proposal.content ?? ''), 160) } } : {}),
  })
  if (!added.ok) return fail(added.error, 'write-failed')
  const decided = await context.store.approvePending(String(id.value))
  if (!decided.ok) {
    // The entry now exists: say so instead of pretending nothing happened.
    return fail(`entry ${added.data.id} was stored but the proposal could not be marked approved (${decided.error})`, 'partial')
  }
  if (decided.data === null) return fail(`entry ${added.data.id} was stored but pending/${id.value} vanished before the decision was recorded`, 'partial')
  return ok({ pendingId: String(id.value), entryId: added.data.id, track: wanted.value })
}

/** Reject a pending proposal; the decided row stays as an audit trail. */
export async function rejectPending(
  context: MemoryContext,
  args: { id?: unknown; reason?: unknown },
): Promise<OpResult<{ pendingId: string; status: PendingItem['status'] }>> {
  const id = parseString(args.id, 'id', { required: true })
  if (isFail(id)) return id
  if (!isSafeKey(String(id.value))) return fail('id must be a pending-item id', 'bad-id')
  const result = await context.store.rejectPending(String(id.value))
  if (!result.ok) return fail(result.error, 'write-failed')
  if (result.data === null) return fail(`no pending proposal with id ${id.value}`, 'not-found')
  return ok({ pendingId: String(id.value), status: result.data.status })
}
