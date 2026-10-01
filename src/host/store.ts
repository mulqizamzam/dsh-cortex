import { join } from 'node:path'
import { DEFAULT_CAPS, clampText as rawClampText } from '../lib/caps.ts'
import { neutralize } from '../lib/sanitize.ts'
/** Single choke point (DESIGN P9): every persisted model-visible string passes
 * here — brace-neutralize BEFORE the clamp, so stored data can never re-form
 * template pairs at render time even if a module forgets to sanitize. */
const clampText = (input: string, max: number): string => rawClampText(neutralize(input), max)
import type { CortexCaps } from '../lib/caps.ts'
import { attempt, errorMessage } from '../lib/errors.ts'
import type { CortexResult } from '../lib/errors.ts'
import { branchMatches } from '../lib/gitx.ts'
import { ensureDir, ensureStateRoot } from '../lib/home.ts'
import { appendMdCapped, dirBytes, listDir, listNames, readJsonSafe, readTextSafe, sizeOf, writeJsonAtomic, writeTextAtomic } from '../lib/fsx.ts'
import type { WarnFn } from '../lib/fsx.ts'
import { isoDate, isSafeKey, newId, shiftDate } from '../lib/ids.ts'
import type {
  Board, BoardCard, BoardComment, Decision, Entry, InjectQueue, Job, LogRef, PendingItem, ProjectMeta, PromptDoc, Room, RoomMember,
  RoomMessage, TodoItem, TodoTrack, Track,
} from './types.ts'

/** readdir ceiling per directory: listings stay index-free and bounded (P2). */
export const LIST_CAP = 500
/** State schema marker this build writes; a newer value means read-only upstream. */
export const SCHEMA_VERSION = 1
/** How stale the state-size walk may be before `addEntry` re-measures (v1: cheap,
 * coarse — the quota is a runaway guard, not an exact accounting). */
export const QUOTA_TTL_MS = 5000

export interface StoreOptions {
  /** Absolute state root, injected (host home path in production, tmpdir in tests). */
  root: string
  caps?: CortexCaps | (() => CortexCaps)
  warn?: WarnFn
  now?: () => Date
}

/** Where an entry lives. */
export interface Scope {
  track: Track
  pid?: string
}

/** Choke point (SEC-1 / C-19): no caller-supplied key may escape the state root.
 * Throwing here is safe — every builder is only ever invoked from inside a
 * `this.run(...)` body, so `attempt` turns it into an `{ok:false}` envelope. */
function assertSafeKey(key: string | undefined, label: string): string {
  if (typeof key !== 'string' || !isSafeKey(key)) throw new Error(`unsafe ${label}: ${String(key)}`)
  return key
}

/** Directory helpers for one state root (DESIGN §2 layout). */
export function storePaths(root: string) {
  const project = (pid: string) => join(root, 'projects', assertSafeKey(pid, 'project id'))
  const trackDir = (scope: Scope, kind: 'entries' | 'archive') =>
    scope.track === 'project' ? join(project(assertSafeKey(scope.pid, 'project id')), kind) : join(root, scope.track, kind)
  return {
    root: () => root,
    quarantine: () => join(root, 'quarantine'),
    tmp: () => join(root, 'tmp'),
    schema: () => join(root, 'schema.json'),
    project,
    projectMeta: (pid: string) => join(project(pid), 'meta.json'),
    projectLog: (pid: string, date: string) => join(project(pid), 'log', `${date}.md`),
    projectTodos: (pid: string) => join(project(pid), 'todos.json'),
    dailyLog: (date: string) => join(root, 'daily', `${date}.md`),
    todos: (track: TodoTrack, pid?: string) => (track === 'project' ? join(project(assertSafeKey(pid, 'project id')), 'todos.json') : join(root, 'todos', `${track}.json`)),
    pending: (id: string) => join(root, 'pending', `${id}.json`),
    prompts: (id: string) => join(root, 'prompts', `${id}.json`),
    inject: (sessionId: string) => join(root, 'inject', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown'}.json`),
    room: (roomId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id')),
    roomDoc: (roomId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'room.json'),
    roomSeq: (roomId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'seq.txt'),
    roomMessages: (roomId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'messages'),
    roomMessage: (roomId: string, seq: number) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'messages', `${String(seq).padStart(6, '0')}.json`),
    roomImages: (roomId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'images'),
    board: (roomId: string, boardId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'board', assertSafeKey(boardId, 'board id')),
    boardDoc: (roomId: string, boardId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'board', `${assertSafeKey(boardId, 'board id')}.json`),
    boardCards: (roomId: string, boardId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'board', assertSafeKey(boardId, 'board id'), 'cards'),
    boardCard: (roomId: string, boardId: string, cardId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'board', assertSafeKey(boardId, 'board id'), 'cards', `${assertSafeKey(cardId, 'card id')}.json`),
    boardComments: (roomId: string, boardId: string, cardId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'board', assertSafeKey(boardId, 'board id'), 'comments', assertSafeKey(cardId, 'card id')),
    boardComment: (roomId: string, boardId: string, cardId: string, commentId: string) => join(root, 'rooms', assertSafeKey(roomId, 'room id'), 'board', assertSafeKey(boardId, 'board id'), 'comments', assertSafeKey(cardId, 'card id'), `${assertSafeKey(commentId, 'comment id')}.json`),
    job: (id: string) => join(root, 'delegation', 'jobs', id),
    jobDoc: (id: string) => join(root, 'delegation', 'jobs', id, 'job.json'),
    decisionDir: (pid?: string) => join(root, 'decisions', ...(pid ? [assertSafeKey(pid, 'project id')] : [])),
    decisionPath: (id: string, pid?: string) => join((pid !== undefined ? join(root, 'decisions', assertSafeKey(pid, 'project id')) : join(root, 'decisions')), `${assertSafeKey(id, 'decision id')}.json`),
    entries: (scope: Scope) => trackDir(scope, 'entries'),
    archive: (scope: Scope) => trackDir(scope, 'archive'),
  }
}

/** Render helper (P8): unknown branch (null) shows unscoped entries only. */
export function selectForBranch(entries: readonly Entry[], branch: string | null | undefined): Entry[] {
  const known = typeof branch === 'string' && branch !== '' ? branch : null
  return entries.filter(entry => branchMatches(entry.branches, known))
}

/** Injection order: importance first, then most recently updated. */
export function orderForRender(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

/** Exact rejection message the store emits at the quota ceiling. */
export const STATE_QUOTA_ERROR = 'state quota exceeded'

/** Exact rejection message EVERY write path emits while the on-disk schema is
 * newer than this build (DESIGN §2: versi lebih baru => read-only mode).
 * Reads keep working; nothing is written, downgraded or quarantined. */
export const STATE_READ_ONLY_ERROR = 'state schema is newer than this build: read-only mode (writes are refused, reads still work)'

function clampImportance(value: number | undefined): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 3
  return Math.max(1, Math.min(5, numeric))
}

function normalizeList(values: readonly string[] | undefined, maxChars: number, maxItems = 12): string[] {
  return [...new Set((values ?? []).map(value => clampText(value, maxChars)).filter(Boolean))].slice(0, maxItems)
}

/** Pending proposals carry model-visible strings before approval — sanitize at entry too. */
function sanitizeProposal(p: PendingItem['proposal']): PendingItem['proposal'] {
  const out: PendingItem['proposal'] = { ...p }
  for (const key of ['content', 'text', 'title', 'body', 'category'] as const) {
    const value = out[key]
    if (typeof value === 'string') (out as Record<string, unknown>)[key] = clampText(value, 20000)
  }
  for (const key of ['tags', 'branches'] as const) {
    const value = out[key]
    if (Array.isArray(value)) (out as Record<string, unknown>)[key] = value.map(item => clampText(String(item), 80))
  }
  return out
}

/**
 * File-backed store; the only writer inside the state root (P5).
 * Every public method returns a `StoreResult` envelope and never throws: reads
 * quarantine corrupt files (P4), writes are atomic and capped (P2).
 */
export class CortexStore {
  readonly root: string
  readonly paths: ReturnType<typeof storePaths>
  private readonly capsSource: CortexCaps | (() => CortexCaps)
  private readonly warn: WarnFn
  private readonly clock: () => Date
  private quotaSample: { at: number; bytes: number } | undefined
  private quotaDelta = 0
  /** Cached schema verdict for the write gate; `undefined` = not probed yet. */
  private readOnlyState: boolean | undefined
  /** One in-flight write per room (`postMessage`'s seq is a read-modify-write). */
  private readonly roomChains = new Map<string, Promise<void>>()

  constructor(options: StoreOptions) {
    this.root = options.root
    this.paths = storePaths(options.root)
    this.capsSource = options.caps ?? DEFAULT_CAPS
    this.warn = options.warn ?? (message => { console.warn(`[dsh-cortex:store] ${message}`) })
    this.clock = options.now ?? (() => new Date())
  }

  get caps(): CortexCaps {
    return typeof this.capsSource === 'function' ? this.capsSource() : this.capsSource
  }

  private iso(): string { return this.clock().toISOString() }
  private today(): string { return isoDate(this.clock()) }

  /** State size, from a throttled walk plus what this process wrote since. */
  private async stateBytes(needed: number): Promise<number> {
    const quota = this.caps.stateQuotaBytes
    const at = this.clock().getTime()
    if (this.quotaSample === undefined || at - this.quotaSample.at > QUOTA_TTL_MS) {
      this.quotaSample = { at, bytes: await dirBytes(this.root, quota + needed + this.quotaDelta) }
      this.quotaDelta = 0
    }
    return this.quotaSample.bytes + this.quotaDelta + needed
  }

  private run<T>(label: string, body: () => Promise<T>): Promise<CortexResult<T>> {
    return attempt(body, this.warn, label)
  }

  /** Every WRITE method goes through here; reads keep `run()` directly. The
   * schema gate lives at this single boundary, so no write path can skip it by
   * forgetting a check of its own. */
  private write<T>(label: string, body: () => Promise<T>): Promise<CortexResult<T>> {
    return this.run(label, async () => {
      if (await this.stateIsReadOnly()) throw new Error(STATE_READ_ONLY_ERROR)
      return body()
    })
  }

  /** Serialize work per room: `postMessage` derives its seq from a
   * read-modify-write, so two concurrent posts to the SAME room would both
   * compute the same seq and the second file would overwrite the first.
   * Different rooms stay independent, the chain never rejects (one failed write
   * cannot poison later writes), and the map entry is dropped once the chain
   * drains so one-post rooms are not retained. */
  serializePerRoom<T>(roomId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.roomChains.get(roomId) ?? Promise.resolve()
    const result = previous.then(body, body)
    const tail = result.then(() => undefined, () => undefined)
    this.roomChains.set(roomId, tail)
    void tail.then(() => { if (this.roomChains.get(roomId) === tail) this.roomChains.delete(roomId) })
    return result
  }

  /** Read-only probe, side-effect free (never quarantines the marker). */
  private async stateIsReadOnly(): Promise<boolean> {
    if (this.readOnlyState === undefined) this.readOnlyState = await this.detectNewerSchema()
    return this.readOnlyState
  }

  private async detectNewerSchema(): Promise<boolean> {
    const raw = await readTextSafe(this.paths.schema(), this.warn)
    if (raw === null) return false
    try {
      const parsed = JSON.parse(raw) as { version?: unknown }
      return typeof parsed.version === 'number' && parsed.version > SCHEMA_VERSION
    } catch {
      return false
    }
  }

  /** Module seam (P5): module-owned files inside the state root go through the
   * same schema gate and the same envelope as the store's own writes, so no
   * module can write into a state root this build must not touch. */
  writeStateFile(file: string, text: string): Promise<CortexResult<{ path: string }>> {
    return this.write('writeStateFile', async () => {
      await writeTextAtomic(file, text)
      return { path: file }
    })
  }

  writeStateJson(file: string, value: unknown): Promise<CortexResult<{ path: string }>> {
    return this.write('writeStateJson', async () => {
      await writeJsonAtomic(file, value)
      return { path: file }
    })
  }

  private read<T>(file: string, fallback: T): Promise<T> {
    return readJsonSafe(file, { fallback, quarantineDir: this.paths.quarantine(), warn: this.warn })
  }

  /** Create the scaffold + schema marker. A state written by a NEWER schema is
   * never rewritten down: the marker is left exactly as found, the store enters
   * read-only mode (DESIGN §2) and every write path refuses from then on. */
  init(): Promise<CortexResult<{ root: string }>> {
    return this.run('init', async () => {
      await ensureStateRoot(this.root)
      const existing = await this.read<{ version?: number }>(this.paths.schema(), { version: 0 })
      const found = existing.version ?? 0
      this.readOnlyState = found > SCHEMA_VERSION
      if (this.readOnlyState) {
        this.warn(`schema.json is version ${String(found)}, newer than this build (${String(SCHEMA_VERSION)}): read-only, no writes and no downgrade`)
        return { root: this.root }
      }
      if (found !== SCHEMA_VERSION) {
        await writeJsonAtomic(this.paths.schema(), { version: SCHEMA_VERSION, writtenAt: this.iso() })
      }
      return { root: this.root }
    })
  }

  /** The only destructive operation (P6). */
  purgeRoot(): Promise<CortexResult<{ removed: string }>> {
    return this.write('purgeRoot', async () => {
      const { rm } = await import('node:fs/promises')
      await rm(this.root, { recursive: true, force: true })
      return { removed: this.root }
    })
  }

  // ---------------------------------------------------------------- entries --
  addEntry(input: { scope: Scope; content: string; importance?: number; tags?: string[]; branches?: string[]; origin?: Entry['origin']; source?: Entry['source'] }): Promise<CortexResult<Entry>> {
    return this.write('addEntry', async () => {
      const now = this.iso()
      // Quota gate BEFORE writing: one file per entry, so an estimate of this
      // payload is enough to refuse a runaway writer (P2). The thrown message is
      // what the caller sees in the envelope.
      const estimate = JSON.stringify(input).length + 64
      if ((await this.stateBytes(estimate)) > this.caps.stateQuotaBytes) {
        throw new Error(STATE_QUOTA_ERROR)
      }
      const entry: Entry = {
        id: newId(),
        track: input.scope.track,
        content: clampText(input.content, this.caps.entryChars),
        importance: clampImportance(input.importance),
        tags: normalizeList(input.tags, 40),
        createdAt: now,
        updatedAt: now,
        origin: input.origin ?? 'user',
        ...(input.branches && input.branches.length > 0 ? { branches: normalizeList(input.branches, 80) } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.scope.track === 'project' ? { pid: input.scope.pid } : {}),
      }
      const dir = this.paths.entries(input.scope)
      await ensureDir(dir)
      await writeJsonAtomic(join(dir, `${entry.id}.json`), entry)
      this.quotaDelta += estimate
      return entry
    })
  }

  listEntries(filter: { track?: Track; pid?: string; branch?: string | null; archived?: boolean; limit?: number } = {}): Promise<CortexResult<{ entries: Entry[]; truncated: boolean }>> {
    return this.run('listEntries', async () => {
      const scopes: Scope[] = filter.track === undefined
        ? [{ track: 'user' }, { track: 'global' }, ...(filter.pid ? [{ track: 'project' as const, pid: filter.pid }] : [])]
        : [filter.track === 'project' ? { track: 'project', pid: filter.pid } : { track: filter.track }]
      const limit = filter.limit ?? LIST_CAP
      const found: Entry[] = []
      let truncated = false
      for (const scope of scopes) {
        if (scope.track === 'project' && !scope.pid) continue
        const dir = this.paths[filter.archived ? 'archive' : 'entries'](scope)
        const page = await listDir(dir, limit)
        truncated = truncated || page.truncated
        for (const name of page.names) {
          if (!name.endsWith('.json')) continue
          const entry = await this.read<Entry | null>(join(dir, name), null)
          if (entry && isSafeKey(entry.id)) found.push({ ...entry, track: scope.track, ...(scope.pid ? { pid: scope.pid } : {}) })
        }
      }
      const scoped = filter.branch === undefined ? found : selectForBranch(found, filter.branch)
      const ordered = orderForRender(scoped)
      if (ordered.length > limit) return { entries: ordered.slice(0, limit), truncated: true }
      return { entries: ordered, truncated }
    })
  }

  /** Locate the file behind one id (archive included unless `archived` is set). */
  private async locate(id: string, pid: string | undefined, archived: boolean | undefined): Promise<{ entry: Entry; file: string; scope: Scope } | null> {
    if (!isSafeKey(id)) return null
    const scopes: Scope[] = pid
      ? [{ track: 'project', pid }, { track: 'user' }, { track: 'global' }]
      : [{ track: 'user' }, { track: 'global' }]
    for (const scope of scopes) {
      const dirs = archived === undefined ? [this.paths.entries(scope), this.paths.archive(scope)] : [this.paths[archived ? 'archive' : 'entries'](scope)]
      for (const dir of dirs) {
        const file = join(dir, `${id}.json`)
        const entry = await this.read<Entry | null>(file, null)
        if (entry && isSafeKey(entry.id)) return { entry, file, scope }
      }
    }
    return null
  }

  updateEntry(id: string, patch: { content?: string; importance?: number; tags?: string[]; branches?: string[] | null; pid?: string }): Promise<CortexResult<Entry | null>> {
    return this.write('updateEntry', async () => {
      const found = await this.locate(id, patch.pid, undefined)
      if (!found) return null
      const next: Entry = {
        ...found.entry,
        updatedAt: this.iso(),
        ...(patch.content !== undefined ? { content: clampText(patch.content, this.caps.entryChars) } : {}),
        ...(patch.importance !== undefined ? { importance: clampImportance(patch.importance) } : {}),
        ...(patch.tags !== undefined ? { tags: normalizeList(patch.tags, 40) } : {}),
      }
      if (patch.branches !== undefined) {
        if (patch.branches === null || patch.branches.length === 0) delete next.branches
        else next.branches = normalizeList(patch.branches, 80)
      }
      await writeJsonAtomic(found.file, next)
      return next
    })
  }

  /** Move one entry file between `entries/` and `archive/` (out of / into injection). */
  private move(id: string, pid: string | undefined, toArchive: boolean): Promise<CortexResult<Entry | null>> {
    return this.write(toArchive ? 'archiveEntry' : 'restoreEntry', async () => {
      const found = await this.locate(id, pid, toArchive ? false : true)
      if (!found) return null
      const scope: Scope = { track: found.entry.track, pid: found.entry.pid ?? found.scope.pid }
      const target = join(this.paths[toArchive ? 'archive' : 'entries'](scope), `${id}.json`)
      await ensureDir(join(target, '..'))
      if (toArchive) await writeJsonAtomic(target, { ...found.entry, archivedAt: this.iso(), updatedAt: this.iso() })
      else {
        const { archivedAt: _drop, ...rest } = found.entry
        await writeJsonAtomic(target, { ...rest, updatedAt: this.iso() })
      }
      const { rm } = await import('node:fs/promises')
      await rm(found.file, { force: true })
      return found.entry
    })
  }

  archiveEntry(id: string, pid?: string): Promise<CortexResult<Entry | null>> { return this.move(id, pid, true) }
  restoreEntry(id: string, pid?: string): Promise<CortexResult<Entry | null>> { return this.move(id, pid, false) }

  /** Per-file delete by id — no directory-level rename (DESIGN §2). */
  deleteEntry(id: string, pid?: string): Promise<CortexResult<boolean>> {
    return this.write('deleteEntry', async () => {
      const found = await this.locate(id, pid, undefined)
      if (!found) return false
      const { rm } = await import('node:fs/promises')
      await rm(found.file, { force: true })
      return true
    })
  }

  // ------------------------------------------------------------------ todos --
  private todoFile(track: TodoTrack, pid?: string): string {
    return this.paths.todos(track, track === 'project' ? pid : undefined)
  }

  private async readTodos(track: TodoTrack, pid?: string): Promise<TodoItem[]> {
    const list = await this.read<TodoItem[]>(this.todoFile(track, pid), [])
    return Array.isArray(list) ? list.filter(item => item && isSafeKey(String(item.id))) : []
  }

  addTodo(input: { track: TodoTrack; text: string; pid?: string; important?: boolean; urgent?: boolean; due?: string }): Promise<CortexResult<TodoItem>> {
    return this.write('addTodo', async () => {
      if (input.track === 'project' && !input.pid) throw new Error('project todos need a project id')
      const item: TodoItem = {
        id: newId(),
        track: input.track,
        text: clampText(input.text, this.caps.entryChars),
        done: false,
        createdAt: this.iso(),
        ...(input.important !== undefined ? { important: input.important } : {}),
        ...(input.urgent !== undefined ? { urgent: input.urgent } : {}),
        ...(input.due !== undefined ? { due: input.due } : {}),
      }
      const list = await this.readTodos(input.track, input.pid)
      await writeJsonAtomic(this.todoFile(input.track, input.pid), [...list, item])
      return item
    })
  }

  listTodos(options: { tracks?: TodoTrack[]; pid?: string; openOnly?: boolean } = {}): Promise<CortexResult<TodoItem[]>> {
    return this.run('listTodos', async () => {
      const tracks = options.tracks ?? (options.pid ? (['life', 'work', 'daily', 'project'] as TodoTrack[]) : (['life', 'work', 'daily'] as TodoTrack[]))
      const items: TodoItem[] = []
      for (const track of tracks) {
        if (track === 'project' && !options.pid) continue
        items.push(...await this.readTodos(track, options.pid))
      }
      const open = options.openOnly === true ? items.filter(item => item.done !== true) : items
      return open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    })
  }

  updateTodo(id: string, patch: { done?: boolean; text?: string; important?: boolean; urgent?: boolean; due?: string; pid?: string }): Promise<CortexResult<TodoItem | null>> {
    return this.write('updateTodo', async () => {
      for (const track of ['life', 'work', 'daily', 'project'] as TodoTrack[]) {
        if (track === 'project' && !patch.pid) continue
        const list = await this.readTodos(track, patch.pid)
        const index = list.findIndex(item => item.id === id)
        if (index < 0) continue
        const current = list[index] as TodoItem
        const next: TodoItem = {
          ...current,
          ...(patch.done !== undefined ? { done: patch.done } : {}),
          ...(patch.text !== undefined ? { text: clampText(patch.text, this.caps.entryChars) } : {}),
          ...(patch.important !== undefined ? { important: patch.important } : {}),
          ...(patch.urgent !== undefined ? { urgent: patch.urgent } : {}),
          ...(patch.due !== undefined ? { due: patch.due } : {}),
        }
        if (patch.done === true) next.completedAt = this.iso()
        if (patch.done === false) delete next.completedAt
        const copy = [...list]
        copy[index] = next
        await writeJsonAtomic(this.todoFile(track, patch.pid), copy)
        return next
      }
      return null
    })
  }

  removeTodo(id: string, pid?: string): Promise<CortexResult<boolean>> {
    return this.write('removeTodo', async () => {
      for (const track of ['life', 'work', 'daily', 'project'] as TodoTrack[]) {
        if (track === 'project' && !pid) continue
        const list = await this.readTodos(track, pid)
        const next = list.filter(item => item.id !== id)
        if (next.length === list.length) continue
        await writeJsonAtomic(this.todoFile(track, pid), next)
        return true
      }
      return false
    })
  }

  // ------------------------------------------------------------------- logs --
  logAppend(input: { scope: 'project' | 'daily'; text: string; pid?: string; date?: string }): Promise<CortexResult<LogRef>> {
    return this.write('logAppend', async () => {
      const date = input.date ?? this.today()
      if (input.scope === 'project' && !input.pid) throw new Error('project logs need a project id')
      const file = input.scope === 'project' ? this.paths.projectLog(input.pid as string, date) : this.paths.dailyLog(date)
      const line = `- ${clampText(input.text, this.caps.logLineChars)}`
      const result = await appendMdCapped(file, line, this.caps.logLineChars, this.caps.logDayChars, clampText, this.warn)
      return { scope: input.scope, ...(input.pid ? { pid: input.pid } : {}), date, line, ...(result.rolled ? { rolled: true } : {}) }
    })
  }

  logRead(input: { scope: 'project' | 'daily'; pid?: string; date?: string; lastDays?: number }): Promise<CortexResult<{ date: string; days: string[]; text: string }>> {
    return this.run('logRead', async () => {
      const base = input.date ?? this.today()
      const window = Math.max(1, Math.min(input.lastDays ?? 1, 90))
      const days: string[] = []
      const parts: string[] = []
      if (input.scope === 'project' && input.pid === undefined) {
        // No project scope: the day names still come back (a caller shows which
        // days it asked for), exactly as the per-day `continue` used to.
        for (let index = 0; index < window; index += 1) days.push(shiftDate(base, -index))
        return { date: base, days, text: '' }
      }
      // ONE uncapped listing per read, indexed by the date each FILE NAME
      // carries. The previous shape re-listed the same directory once per day
      // through the capped `listDir`, so a log directory holding more than the
      // cap answered the NEWEST days with nothing at all while their files sat
      // on disk. The predicate stays deliberately loose (`<day>….md`, so a
      // hand-made `2026-03-04-huge.md` still reads as that day, as before);
      // `pruneLogs` is the stricter side of this pair because deleting is
      // narrower than reading.
      const dir = input.scope === 'project'
        ? join(this.paths.projectLog(input.pid as string, base), '..')
        : join(this.paths.dailyLog(base), '..')
      const byDay = new Map<string, string[]>()
      for (const name of await listNames(dir)) {
        if (!name.endsWith('.md')) continue
        const match = /^(\d{4}-\d{2}-\d{2})/.exec(name)
        if (match === null) continue
        const day = match[1] as string
        const bucket = byDay.get(day)
        if (bucket === undefined) byDay.set(day, [name])
        else bucket.push(name)
      }
      for (let index = 0; index < window; index += 1) {
        const day = shiftDate(base, -index)
        days.push(day)
        for (const name of byDay.get(day) ?? []) {
          const text = await readTextSafe(join(dir, name), this.warn)
          if (text) parts.push(`### ${day} (${name})\n${text.trimEnd()}`)
        }
      }
      const joined = parts.join('\n\n')
      return { date: base, days, text: joined.length > this.caps.searchResultChars ? `${joined.slice(0, this.caps.searchResultChars)}\n[… truncated]` : joined }
    })
  }

  /**
   * Retention (`retention.dailyLogDays`): drop day files whose date is older
   * than the window, rollover parts included. Idempotent (a second call removes
   * nothing), never throws, and leaves any file it does not recognise as a
   * date-named log part untouched. Goes through the write gate, so a state
   * root this build must not touch is never pruned.
   */
  pruneLogs(input: { days: number; scope: 'daily' | 'project'; pid?: string }): Promise<CortexResult<{ removed: string[] }>> {
    return this.write('pruneLogs', async () => {
      if (input.scope === 'project' && input.pid === undefined) throw new Error('project logs need a project id')
      // A window below one day means "retention off" (the same `0 = off`
      // reading `logReview.everyTurns` uses), never "delete everything".
      if (!Number.isFinite(input.days) || input.days < 1) return { removed: [] }
      const days = Math.min(Math.floor(input.days), 3650)
      // Keep the newest `days` day files, today included.
      const cutoff = shiftDate(this.today(), -(days - 1))
      const dir = input.scope === 'project' ? join(this.paths.project(input.pid as string), 'log') : join(this.root, 'daily')
      const { rm } = await import('node:fs/promises')
      const removed: string[] = []
      for (const name of await listNames(dir)) {
        const match = /^(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/.exec(name)
        if (match === null) continue
        if ((match[1] as string) >= cutoff) continue
        const file = join(dir, name)
        try {
          await rm(file, { force: true })
          removed.push(file)
        } catch (error) {
          this.warn(`pruneLogs: could not remove ${name}: ${errorMessage(error)}`)
        }
      }
      return { removed }
    })
  }

  // ------------------------------------------------------------- decisions --
  decisionDir(pid?: string): string {
    return join(this.root, 'decisions', ...(pid ? [pid] : []))
  }
  decisionPath(id: string, pid?: string): string {
    return join(this.decisionDir(pid), `${assertSafeKey(id, 'decision id')}.json`)
  }
  addDecision(input: { id: string; decision: Decision; pid?: string }): Promise<CortexResult<Decision>> {
    return this.write('addDecision', async () => {
      if (!isSafeKey(input.id)) throw new Error('unsafe decision id')
      const file = this.paths.decisionPath(input.id, input.pid)
      await ensureDir(join(file, '..'))
      await writeJsonAtomic(file, input.decision)
      return input.decision
    })
  }
  listDecisions(options: { pid?: string; tags?: string[]; limit?: number } = {}): Promise<CortexResult<Decision[]>> {
    return this.run('listDecisions', async () => {
      const dir = this.paths.decisionDir(options.pid)
      const { names } = await listDir(dir, options.limit ?? LIST_CAP)
      const decisions: Decision[] = []
      for (const name of names.filter(n => n.endsWith('.json'))) {
        const d = await this.read<Decision | null>(join(dir, name), null)
        if (!d || !isSafeKey(String(d.id ?? ''))) continue
        if (options.tags && options.tags.length > 0) {
          const hasAll = options.tags.every(t => (d.tags ?? []).includes(t))
          if (!hasAll) continue
        }
        decisions.push(d)
      }
      return decisions.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    })
  }
  getDecision(id: string, pid?: string): Promise<CortexResult<Decision | null>> {
    return this.run('getDecision', async () => {
      if (!isSafeKey(id)) return null
      return await this.read<Decision | null>(this.paths.decisionPath(id, pid), null)
    })
  }
  /**
   * Patch a stored decision. Only the mutable, non-derivable fields are
   * writable: `context`/`options`/`chosen`/`rationale` are what the parser
   * derived from the log line, so editing them by hand would make the record
   * disagree with the log it claims to come from. `id` is immutable because it
   * is the file name.
   */
  updateDecision(id: string, patch: { linkedEntries?: string[]; tags?: string[]; owner?: string }, pid?: string): Promise<CortexResult<Decision | null>> {
    return this.write('updateDecision', async () => {
      if (!isSafeKey(id)) return null
      const current = await this.getDecision(id, pid)
      if (current.data === null || current.data === undefined) return null
      const next: Decision = {
        ...current.data,
        ...(patch.linkedEntries !== undefined ? { linkedEntries: patch.linkedEntries } : {}),
        ...(patch.tags !== undefined ? { tags: normalizeList(patch.tags, 80) } : {}),
        ...(patch.owner !== undefined ? { owner: clampText(patch.owner, 80) } : {}),
      }
      await writeJsonAtomic(this.paths.decisionPath(id, pid), next)
      return next
    })
  }

  // --------------------------------------------------------------- pending --
  addPending(input: { kind: PendingItem['kind']; proposal: PendingItem['proposal']; reason?: string; fromSessionId?: string }): Promise<CortexResult<PendingItem>> {
    return this.write('addPending', async () => {
      const item: PendingItem = {
        id: newId(), kind: input.kind, proposal: sanitizeProposal(input.proposal ?? {}), createdAt: this.iso(), status: 'pending',
        ...(input.reason ? { reason: clampText(input.reason, 500) } : {}),
        ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
      }
      await writeJsonAtomic(this.paths.pending(item.id), item)
      return item
    })
  }

  listPending(options: { status?: PendingItem['status']; limit?: number } = {}): Promise<CortexResult<PendingItem[]>> {
    return this.run('listPending', async () => {
      const dir = join(this.root, 'pending')
      const { names } = await listDir(dir, options.limit ?? LIST_CAP)
      const items: PendingItem[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const item = await this.read<PendingItem | null>(join(dir, name), null)
        if (!item || !isSafeKey(String(item.id ?? ''))) continue
        if (options.status && item.status !== options.status) continue
        items.push(item)
      }
      return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    })
  }

  /** Approve/reject keeps the row as an audit trail; M8's UI applies the payload. */
  private decide(id: string, status: 'approved' | 'rejected'): Promise<CortexResult<PendingItem | null>> {
    return this.write(`pending/${status}`, async () => {
      if (!isSafeKey(id)) return null
      const file = this.paths.pending(id)
      if ((await sizeOf(file)) === null) return null
      const item = await this.read<PendingItem | null>(file, null)
      if (!item) return null
      const next: PendingItem = { ...item, status, decidedAt: this.iso() }
      await writeJsonAtomic(file, next)
      return next
    })
  }

  approvePending(id: string): Promise<CortexResult<PendingItem | null>> { return this.decide(id, 'approved') }
  rejectPending(id: string): Promise<CortexResult<PendingItem | null>> { return this.decide(id, 'rejected') }

  // --------------------------------------------------------------- prompts --
  addPrompt(input: { title: string; body: string; category?: string; enabled?: boolean }): Promise<CortexResult<PromptDoc>> {
    return this.write('addPrompt', async () => {
      const now = this.iso()
      const doc: PromptDoc = {
        id: newId(), title: clampText(input.title, 120), body: clampText(String(input.body ?? ''), 20000), enabled: input.enabled !== false,
        createdAt: now, updatedAt: now, ...(input.category ? { category: clampText(input.category, 40) } : {}),
      }
      await writeJsonAtomic(this.paths.prompts(doc.id), doc)
      return doc
    })
  }

  listPrompts(options: { category?: string; enabled?: boolean } = {}): Promise<CortexResult<PromptDoc[]>> {
    return this.run('listPrompts', async () => {
      const dir = join(this.root, 'prompts')
      const { names } = await listDir(dir, LIST_CAP)
      const docs: PromptDoc[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const doc = await this.read<PromptDoc | null>(join(dir, name), null)
        if (!doc || !isSafeKey(String(doc.id ?? ''))) continue
        if (options.category && doc.category !== options.category) continue
        if (options.enabled !== undefined && doc.enabled !== options.enabled) continue
        docs.push(doc)
      }
      return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    })
  }

  getPrompt(id: string): Promise<CortexResult<PromptDoc | null>> {
    return this.run('getPrompt', async () => (isSafeKey(id) ? await this.read<PromptDoc | null>(this.paths.prompts(id), null) : null))
  }

  updatePrompt(id: string, patch: Partial<Pick<PromptDoc, 'title' | 'body' | 'category' | 'enabled'>>): Promise<CortexResult<PromptDoc | null>> {
    return this.write('updatePrompt', async () => {
      const current = (await this.getPrompt(id)).data ?? null
      if (current === null) return null
      const next: PromptDoc = {
        ...current, updatedAt: this.iso(),
        ...(patch.title !== undefined ? { title: clampText(patch.title, 120) } : {}),
        ...(patch.body !== undefined ? { body: clampText(String(patch.body), 20000) } : {}),
        ...(patch.category !== undefined ? { category: clampText(patch.category, 40) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      }
      await writeJsonAtomic(this.paths.prompts(id), next)
      return next
    })
  }

  deletePrompt(id: string): Promise<CortexResult<boolean>> {
    return this.write('deletePrompt', async () => {
      if (!isSafeKey(id)) return false
      const file = this.paths.prompts(id)
      if ((await sizeOf(file)) === null) return false
      const { rm } = await import('node:fs/promises')
      await rm(file, { force: true })
      return true
    })
  }

  // -------------------------------------------------------- inject queues --
  async readInjectQueue(sessionId: string): Promise<InjectQueue> {
    const file = this.paths.inject(sessionId)
    const value = await this.read<InjectQueue | null>(file, null)
    return value && Array.isArray(value.items) ? value : { sessionId, items: [], updatedAt: '' }
  }

  injectPush(sessionId: string, item: { promptId: string; mode: 'once' | 'sticky' }): Promise<CortexResult<InjectQueue>> {
    return this.write('injectPush', async () => {
      const queue = await this.readInjectQueue(sessionId)
      const items = [...queue.items.filter(existing => existing.promptId !== item.promptId), { ...item, at: this.iso() }]
      const next: InjectQueue = { sessionId, items, updatedAt: this.iso() }
      await writeJsonAtomic(this.paths.inject(sessionId), next)
      return next
    })
  }

  /** Rendered `once` rows are consumed; sticky rows persist. */
  injectConsume(sessionId: string, promptIds: readonly string[]): Promise<CortexResult<InjectQueue>> {
    return this.write('injectConsume', async () => {
      const queue = await this.readInjectQueue(sessionId)
      const done = new Set(promptIds)
      const items = queue.items.filter(entry => !(entry.mode === 'once' && done.has(entry.promptId)))
      const next: InjectQueue = { sessionId, items, updatedAt: this.iso() }
      await writeJsonAtomic(this.paths.inject(sessionId), next)
      return next
    })
  }

  // ----------------------------------------------------------------- rooms --
  createRoom(input: { title: string; createdBy?: string }): Promise<CortexResult<Room>> {
    return this.write('createRoom', async () => {
      const room: Room = { id: newId(), title: clampText(input.title, 120), members: [], createdBy: input.createdBy ?? 'user', createdAt: this.iso(), lastSeq: 0 }
      await ensureDir(this.paths.roomMessages(room.id))
      await ensureDir(this.paths.roomImages(room.id))
      await writeJsonAtomic(this.paths.roomDoc(room.id), room)
      await writeTextAtomic(this.paths.roomSeq(room.id), '0\n')
      return room
    })
  }

  getRoom(roomId: string): Promise<CortexResult<Room | null>> {
    return this.run('getRoom', async () => (isSafeKey(roomId) ? await this.read<Room | null>(this.paths.roomDoc(roomId), null) : null))
  }

  joinRoom(roomId: string, member: Partial<RoomMember> & { label: string }): Promise<CortexResult<Room | null>> {
    return this.write('joinRoom', async () => {
      const room = (await this.getRoom(roomId)).data ?? null
      if (room === null) return null
      const key = member.sessionId ?? `label:${member.label}`
      const members = [...room.members]
      const index = members.findIndex(candidate => (candidate.sessionId ?? `label:${candidate.label}`) === key)
      if (index >= 0) members[index] = { ...(members[index] as RoomMember), ...member, label: clampText((member.label || (members[index] as RoomMember).label), 60) }
      else members.push({ state: 'unknown', ...member, label: clampText(member.label, 60), joinedAt: this.iso() })
      const next: Room = { ...room, members }
      await writeJsonAtomic(this.paths.roomDoc(roomId), next)
      return next
    })
  }

  /**
   * Post with the `seq.txt` counter: the file wins, and a lost counter is
   * recovered above the highest existing message, so seq stays monotonic across
   * a restart.
   */
  postMessage(roomId: string, input: { text: string; fromKind?: RoomMessage['fromKind']; fromSessionId?: string; fromLabel?: string; images?: string[]; jobId?: string }): Promise<CortexResult<RoomMessage | null>> {
    return this.serializePerRoom(roomId, () => this.write('postMessage', async () => {
      const room = (await this.getRoom(roomId)).data ?? null
      if (room === null) return null
      const counterFile = this.paths.roomSeq(roomId)
      const raw = await readTextSafe(counterFile, this.warn)
      const parsed = Number.parseInt((raw ?? '0').trim(), 10)
      let seq = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      if (seq === 0) {
        const { names } = await listDir(this.paths.roomMessages(roomId), 2000)
        for (const name of names) {
          const value = Number.parseInt(name.replace(/\.json$/, ''), 10)
          if (Number.isFinite(value) && value > seq) seq = value
        }
      }
      const next = seq + 1
      const message: RoomMessage = {
        seq: next, roomId, fromKind: input.fromKind ?? 'session',
        text: clampText(input.text, this.caps.logLineChars * 4),
        images: Array.isArray(input.images) ? input.images.map(String).slice(0, 8) : [],
        at: this.iso(),
        ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
        ...(input.fromLabel ? { fromLabel: clampText(input.fromLabel, 60) } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
      }
      await writeTextAtomic(counterFile, `${String(next)}\n`)
      await writeJsonAtomic(this.paths.roomMessage(roomId, next), message)
      await writeJsonAtomic(this.paths.roomDoc(roomId), { ...room, lastSeq: next })
      return message
    }))
  }

  readMessages(roomId: string, options: { sinceSeq?: number; limit?: number } = {}): Promise<CortexResult<RoomMessage[]>> {
    return this.run('readMessages', async () => {
      const dir = this.paths.roomMessages(roomId)
      // The seq lives in the FILE NAME (`000123.json`), so the page is chosen
      // from the names and only those files are opened. The previous shape took
      // the oldest LIST_CAP names, read and parsed every one of them, and only
      // THEN applied `sinceSeq`: past 500 messages the newest rows were
      // unreachable and a `sinceSeq` above the page answered with nothing.
      // Numerically sorted, because zero-padding is not enough past 999999
      // (`1000000` sorts before `0999999` as text).
      const rows: { seq: number; name: string }[] = []
      for (const name of await listNames(dir)) {
        if (!name.endsWith('.json')) continue
        const seq = Number.parseInt(name.slice(0, -'.json'.length), 10)
        if (!Number.isFinite(seq)) continue
        if (options.sinceSeq !== undefined && seq <= options.sinceSeq) continue
        rows.push({ seq, name })
      }
      rows.sort((a, b) => a.seq - b.seq)
      const limit = options.limit ?? 50
      const page = rows.slice(Math.max(0, rows.length - limit))
      const messages: RoomMessage[] = []
      for (const row of page) {
        const message = await this.read<RoomMessage | null>(join(dir, row.name), null)
        if (!message || typeof message.seq !== 'number') continue
        messages.push(message)
      }
      return messages.sort((a, b) => a.seq - b.seq)
    })
  }

  // ------------------------------------------------------------------ jobs --
  jobPaths(id: string): { dir: string; doc: string; stdout: string; stderr: string; result: string } {
    const dir = this.paths.job(id)
    return { dir, doc: join(dir, 'job.json'), stdout: join(dir, 'stdout.log'), stderr: join(dir, 'stderr.log'), result: join(dir, 'result.md') }
  }

  createJob(input: { runner: string; argv: string[]; task: string; cwd?: string; pid?: string; roomId?: string; sessionId?: string; maxRetries?: number }): Promise<CortexResult<Job>> {
    return this.write('createJob', async () => {
      const job: Job = {
        id: newId(), runner: input.runner, argv: input.argv.map(String), task: clampText(input.task, 4000),
        status: 'queued', startedAt: this.iso(),
        ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.pid ? { pid: input.pid } : {}),
        ...(input.roomId ? { roomId: input.roomId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.maxRetries !== undefined && input.maxRetries > 0 ? { maxRetries: input.maxRetries, retryCount: 0 } : {}),
      }
      await ensureDir(this.paths.job(job.id))
      await writeJsonAtomic(this.paths.jobDoc(job.id), job)
      return job
    })
  }

  updateJob(id: string, patch: Partial<Job>): Promise<CortexResult<Job | null>> {
    return this.write('updateJob', async () => {
      if (!isSafeKey(id)) return null
      const current = await this.read<Job | null>(this.paths.jobDoc(id), null)
      if (!current) return null
      const next: Job = { ...current, ...patch, id: current.id }
      await writeJsonAtomic(this.paths.jobDoc(id), next)
      return next
    })
  }

  listJobs(): Promise<CortexResult<Job[]>> {
    return this.run('listJobs', async () => {
      const dir = join(this.root, 'delegation', 'jobs')
      const { names } = await listDir(dir, LIST_CAP)
      const jobs: Job[] = []
      for (const name of names) {
        const job = await this.read<Job | null>(this.paths.jobDoc(name), null)
        if (job && isSafeKey(String(job.id ?? ''))) jobs.push(job)
      }
      return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    })
  }

  // ----------------------------------------------------------------- board --
  /**
   * Create a board in a room. Scaffold the card dir so reads don't 404.
   */
  createBoard(input: { roomId: string; title: string; createdBy?: string }): Promise<CortexResult<Board>> {
    return this.write('createBoard', async () => {
      const board: Board = {
        id: newId(),
        roomId: input.roomId,
        title: clampText(input.title, this.caps.entryChars),
        cardIds: [],
        createdAt: this.iso(),
        updatedAt: this.iso(),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      }
      await ensureDir(this.paths.boardCards(input.roomId, board.id))
      await writeJsonAtomic(this.paths.boardDoc(input.roomId, board.id), board)
      return board
    })
  }

  /** Read one board document. Returns null if not found. */
  getBoard(roomId: string, boardId: string): Promise<CortexResult<Board | null>> {
    return this.run('getBoard', async () => {
      if (!isSafeKey(roomId) || !isSafeKey(boardId)) return null
      // File name IS the id, so no need to re-verify after read.
      return await this.read<Board | null>(this.paths.boardDoc(roomId, boardId), null)
    })
  }

  /** List all boards in a room. */
  listBoards(roomId: string): Promise<CortexResult<Board[]>> {
    return this.run('listBoards', async () => {
      if (!isSafeKey(roomId)) return []
      const dir = join(this.paths.room(roomId), 'board')
      const { names } = await listDir(dir, LIST_CAP)
      const boards: Board[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const board = await this.read<Board | null>(join(dir, name), null)
        if (board && isSafeKey(board.id)) boards.push(board)
      }
      return boards.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    })
  }

  /** Add a card to a board; returns the new card. */
  addCard(input: { roomId: string; boardId: string; title: string; description?: string; status?: BoardCard['status']; ownerId?: string; dependencies?: string[] }): Promise<CortexResult<BoardCard>> {
    return this.write('addCard', async () => {
      if (!isSafeKey(input.roomId) || !isSafeKey(input.boardId)) throw new Error('invalid board or room id')
      const board = await this.getBoard(input.roomId, input.boardId)
      if (!board.ok || board.data === null || board.data === undefined) throw new Error('board not found')
      const now = this.iso()
      const card: BoardCard = {
        id: newId(),
        boardId: input.boardId,
        title: clampText(input.title, this.caps.entryChars),
        status: input.status ?? 'backlog',
        dependencies: (input.dependencies ?? []).filter(id => isSafeKey(id)).slice(0, 20),
        createdAt: now,
        updatedAt: now,
        ...(input.description !== undefined ? { description: clampText(input.description, this.caps.entryChars * 4) } : {}),
        ...(input.ownerId !== undefined ? { ownerId: clampText(input.ownerId, 64) } : {}),
      }
      const cardDir = this.paths.boardCards(input.roomId, input.boardId)
      await ensureDir(cardDir)
      await writeJsonAtomic(join(cardDir, `${card.id}.json`), card)
      const updated: Board = { ...board.data, cardIds: [...board.data.cardIds, card.id], updatedAt: now }
      await writeJsonAtomic(this.paths.boardDoc(input.roomId, input.boardId), updated)
      return card
    })
  }

  /** Read one card by id. Returns null if not found. */
  getCard(roomId: string, boardId: string, cardId: string): Promise<CortexResult<BoardCard | null>> {
    return this.run('getCard', async () => {
      if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return null
      const result = await this.read<BoardCard | null>(this.paths.boardCard(roomId, boardId, cardId), null)
      return result && result.id === cardId ? result : null
    })
  }

  /** Update a card's status or fields. Returns the updated card. */
  updateCard(roomId: string, boardId: string, cardId: string, patch: { status?: BoardCard['status']; ownerId?: string; title?: string; description?: string; dependencies?: string[] }): Promise<CortexResult<BoardCard | null>> {
    return this.write('updateCard', async () => {
      if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return null
      const current = await this.getCard(roomId, boardId, cardId)
      if (!current.ok || current.data === null || current.data === undefined) return null
      const now = this.iso()
      const next: BoardCard = {
        ...current.data,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId === undefined ? undefined : clampText(patch.ownerId, 64) } : {}),
        ...(patch.title !== undefined ? { title: clampText(patch.title, this.caps.entryChars) } : {}),
        ...(patch.description !== undefined ? { description: patch.description === undefined ? undefined : clampText(patch.description, this.caps.entryChars * 4) } : {}),
        ...(patch.dependencies !== undefined ? { dependencies: patch.dependencies.filter(id => isSafeKey(id)).slice(0, 20) } : {}),
        updatedAt: now,
      }
      // strip undefined
      const clean: BoardCard = { ...next }
      if (clean.description === undefined) delete clean.description
      if (clean.ownerId === undefined) delete clean.ownerId
      await writeJsonAtomic(this.paths.boardCard(roomId, boardId, cardId), clean)
      return clean
    })
  }

  /** List all cards in a board, newest first. */
  listCards(roomId: string, boardId: string, options?: { status?: BoardCard['status'] }): Promise<CortexResult<BoardCard[]>> {
    return this.run('listCards', async () => {
      if (!isSafeKey(roomId) || !isSafeKey(boardId)) return []
      const dir = this.paths.boardCards(roomId, boardId)
      const { names } = await listDir(dir, LIST_CAP)
      const cards: BoardCard[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const card = await this.read<BoardCard | null>(join(dir, name), null)
        if (card && isSafeKey(card.id)) {
          if (options?.status !== undefined && card.status !== options.status) continue
          cards.push(card)
        }
      }
      return cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    })
  }

  /** Add a comment to a card. */
  addComment(input: { roomId: string; boardId: string; cardId: string; text: string; authorSessionId?: string; authorLabel?: string }): Promise<CortexResult<BoardComment>> {
    return this.write('addComment', async () => {
      if (!isSafeKey(input.roomId) || !isSafeKey(input.boardId) || !isSafeKey(input.cardId)) throw new Error('invalid id')
      const card = await this.getCard(input.roomId, input.boardId, input.cardId)
      if (!card.ok || card.data === null || card.data === undefined) throw new Error('card not found')
      const comment: BoardComment = {
        id: newId(),
        cardId: input.cardId,
        text: clampText(input.text, this.caps.entryChars * 4),
        createdAt: this.iso(),
        ...(input.authorSessionId ? { authorSessionId: clampText(input.authorSessionId, 64) } : {}),
        ...(input.authorLabel ? { authorLabel: clampText(input.authorLabel, 60) } : {}),
      }
      const commentsDir = this.paths.boardComments(input.roomId, input.boardId, input.cardId)
      await ensureDir(commentsDir)
      await writeJsonAtomic(join(commentsDir, `${comment.id}.json`), comment)
      return comment
    })
  }

  /** List comments for a card, oldest first. */
  listComments(roomId: string, boardId: string, cardId: string, options?: { limit?: number }): Promise<CortexResult<BoardComment[]>> {
    return this.run('listComments', async () => {
      if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return []
      const dir = this.paths.boardComments(roomId, boardId, cardId)
      const { names } = await listDir(dir, LIST_CAP)
      const comments: BoardComment[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const comment = await this.read<BoardComment | null>(join(dir, name), null)
        if (comment && isSafeKey(comment.id)) comments.push(comment)
      }
      const sorted = comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return options?.limit !== undefined ? sorted.slice(0, options.limit) : sorted
    })
  }

  /** Delete a card and its comments. */
  deleteCard(roomId: string, boardId: string, cardId: string): Promise<CortexResult<boolean>> {
    return this.write('deleteCard', async () => {
      if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return false
      const card = await this.getCard(roomId, boardId, cardId)
      if (!card.ok || card.data === null || card.data === undefined) return false
      const { rm } = await import('node:fs/promises')
      await rm(this.paths.boardCard(roomId, boardId, cardId), { force: true })
      // Remove card from board doc
      const board = await this.getBoard(roomId, boardId)
      if (board.ok && board.data !== null && board.data !== undefined) {
        const updated: Board = { ...board.data, cardIds: board.data.cardIds.filter(id => id !== cardId), updatedAt: this.iso() }
        await writeJsonAtomic(this.paths.boardDoc(roomId, boardId), updated)
      }
      return true
    })
  }

  /**
   * Delete a room and everything under it.
   *
   * One `rm` on the room dir, because a room owns exactly that subtree:
   * `room.json`, `seq.txt`, `messages/`, `images/` and `board/` (which holds
   * every board, its cards and its comments). Removing the subtree rather than
   * the files individually is what keeps a new kind of room-owned data from
   * being silently orphaned by a delete that only remembered the old list.
   */
  deleteRoom(roomId: string): Promise<CortexResult<boolean>> {
    return this.write('deleteRoom', async () => {
      if (!isSafeKey(roomId)) return false
      const room = await this.getRoom(roomId)
      if (!room.ok || room.data === null || room.data === undefined) return false
      const { rm } = await import('node:fs/promises')
      await rm(this.paths.room(roomId), { recursive: true, force: true })
      return true
    })
  }

  /** Delete a board and all its cards/comments. */
  deleteBoard(roomId: string, boardId: string): Promise<CortexResult<boolean>> {
    return this.write('deleteBoard', async () => {
      if (!isSafeKey(roomId) || !isSafeKey(boardId)) return false
      const board = await this.getBoard(roomId, boardId)
      if (!board.ok || board.data === null || board.data === undefined) return false
      const { rm } = await import('node:fs/promises')
      // Remove the board dir (cards + comments live under it) and the board doc itself.
      // Note: boardDoc is <roomId>/board/<id>.json, sibling to <roomId>/board/<id>/,
      // so both must be removed explicitly.
      await rm(join(this.paths.board(roomId, boardId)), { recursive: true, force: true })
      await rm(this.paths.boardDoc(roomId, boardId), { force: true })
      return true
    })
  }

  // -------------------------------------------------------------- projects --
  ensureProject(pid: string, meta: { remoteUrl?: string; cwd?: string }): Promise<CortexResult<ProjectMeta>> {
    return this.write('ensureProject', async () => {
      if (!isSafeKey(pid)) throw new Error(`unsafe project id: ${pid}`)
      for (const sub of ['entries', 'archive', 'log']) await ensureDir(join(this.paths.project(pid), sub))
      const existing = await this.read<ProjectMeta | null>(this.paths.projectMeta(pid), null)
      const history = [...(existing?.cwdHistory ?? [])]
      if (meta.cwd && history[history.length - 1] !== meta.cwd) history.push(meta.cwd)
      const next: ProjectMeta = {
        pid, cwdHistory: history.slice(-20), createdAt: existing?.createdAt ?? this.iso(),
        ...(meta.remoteUrl ? { remoteUrl: meta.remoteUrl } : existing?.remoteUrl ? { remoteUrl: existing.remoteUrl } : {}),
      }
      await writeJsonAtomic(this.paths.projectMeta(pid), next)
      return next
    })
  }

  /** Counts + paths for `cortex_status`; capped, never throws. */
  statusSnapshot(): Promise<CortexResult<Record<string, unknown>>> {
    return this.run('statusSnapshot', async () => {
      const count = async (dir: string): Promise<number> => (await listDir(dir, LIST_CAP)).names.filter(name => name.endsWith('.json')).length
      const projects = await listDir(join(this.root, 'projects'), 50)
      const schema = await this.read<{ version?: number }>(this.paths.schema(), { version: 0 })
      return {
        stateRoot: this.root,
        schema: schema.version ?? 0,
        readOnly: (schema.version ?? 0) > SCHEMA_VERSION,
        counts: {
          user: await count(this.paths.entries({ track: 'user' })),
          global: await count(this.paths.entries({ track: 'global' })),
          pending: await count(join(this.root, 'pending')),
          prompts: await count(join(this.root, 'prompts')),
          jobs: (await listDir(join(this.root, 'delegation', 'jobs'), LIST_CAP)).names.length,
          quarantined: (await listDir(this.paths.quarantine(), LIST_CAP)).names.length,
          projects: projects.names.length,
        },
      }
    })
  }
}
