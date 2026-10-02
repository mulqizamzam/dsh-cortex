/**
 * Typed data adapter between the browser UI and the two host RPC channels
 * (`.dev/RPC-ENDPOINTS.md`).
 *
 * The UI NEVER calls `connection.rpc.call` directly: every request goes through
 * here, so that
 *
 *   1. the envelope `{ok:true,value}` / `{ok:false,error}` is unwrapped once,
 *      in one place, and a transport that answers with anything else becomes a
 *      typed failure instead of an `undefined` crash several frames later;
 *   2. every method returns a DISCRIMINATED result (`Result<T>`), so a caller
 *      has to look at `ok` before touching `value`;
 *   3. the shapes live in TypeScript, mirroring the host handlers
 *      (`src/host/modules/*\/rpc.ts`), and a test can substitute
 *      `createMockTransport()` for the whole host.
 *
 * Purity: only `import type` from `../../src/host/**` is allowed in a client
 * file, and this file uses NONE — the shapes are re-declared here as the wire
 * contract (a client that type-depends on host internals would break on any
 * host refactor, and `tsdown.client.ts` would refuse to bundle it anyway).
 */
// The two track unions are the host's, taken TYPE-ONLY (purity: nothing from
// `src/host/**` may be imported at runtime into a browser bundle).
import type { TodoTrack, Track } from '../host/types.ts'

export type { TodoTrack, Track }

/** Channel names (src/host/rpc-channels.ts). Duplicated as literals: no runtime import across the boundary. */
export const CORTEX_READ_CHANNEL = '/dsh-cortex-read'
export const CORTEX_WRITE_CHANNEL = '/dsh-cortex-write'
export const CORTEX_PING_ENDPOINT = 'ping'

/** A failure the UI can render verbatim: a stable code plus a neutralized message. */
export interface CortexError {
  code: string
  message: string
}

/** Discriminated result: `ok:true` carries `value`, `ok:false` carries `error`. */
export type CortexResult<T> = { ok: true; value: T } | { ok: false; error: CortexError }

/** The narrow transport shape the client needs (host `connection.rpc.call`). */
export type RpcCall = (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>

/** Optional project/branch scope; the host resolves `cwd` → pid and falls back to global-only. */
export interface CortexScope {
  branch?: string | null
  pid?: string
  cwd?: string
  sessionId?: string
}

/** Project identity, flat on the wire — the shape `memory.*` handlers read. */
export interface ProjectFields {
  projectId?: string
  cwd?: string
  sessionId?: string
}

/**
 * Everything a scope-aware read accepts. `branch` here is a REQUEST filter (ask
 * for this branch); an ANSWER's resolved branch is `string | null`, which is why
 * the two are declared apart instead of one interface extended twice.
 */
export interface ScopeFields extends ProjectFields {
  branch?: string | null
}

export function scopeFields(scope?: CortexScope): ScopeFields {
  if (scope === undefined) return {}
  return {
    ...(typeof scope.branch === 'string' && scope.branch !== '' ? { branch: scope.branch } : {}),
    ...(typeof scope.pid === 'string' && scope.pid !== '' ? { projectId: scope.pid } : {}),
    ...(typeof scope.cwd === 'string' && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    ...(typeof scope.sessionId === 'string' && scope.sessionId !== '' ? { sessionId: scope.sessionId } : {}),
  }
}

// -------------------------------------------------------------- wire shapes --

/** `ping` → the host's own health line (`src/host/index.ts` dispatcher). */
export interface PingValue {
  plugin?: string
  version?: string
  stateRoot?: string
  injectEnabled?: boolean
  echoKeys?: string[]
  modules?: Record<string, string>
  bootError?: string
  errors?: string[]
}

/** `memory.list` row. Mirrors `Entry` in `src/host/types.ts`. */
export interface MemoryEntry {
  id: string
  track: Track
  content: string
  importance: number
  tags?: string[]
  branches?: string[]
  origin?: string
  source?: { sessionId?: string; quote?: string }
  createdAt: string
  updatedAt: string
  archivedAt?: string
  pid?: string
}

/** Answer row, not a query: `branch` is the host's resolved value (null = unknown). */
export interface MemoryListValue extends ProjectFields {
  entries: MemoryEntry[]
  truncated: boolean
  branch: string | null
  pid?: string
  text?: string
}

/** Tab filter chips on the Memory tab: a track, the archive, or everything. */
export type MemoryFilter = 'all' | Track | 'archived'

/** `memory.list` arguments for a filter chip. */
export function memoryFilterArgs(filter: MemoryFilter): { track?: Track; archived?: boolean } {
  if (filter === 'archived') return { archived: true }
  if (filter === 'all') return {}
  return { track: filter }
}

/** `memory.list` arguments. */
export interface MemoryListQuery extends ScopeFields {
  track?: Track
  archived?: boolean
  branchOnly?: boolean
  branch?: string | null
  limit?: number
}

/** `memory.search` row. Mirrors `SearchHit` in `modules/memory/search.ts`. */
export interface MemoryHit {
  id: string
  track: Track
  snippet: string
  score: number
  branches?: string[]
  archived?: boolean
}

export interface MemorySearchValue {
  hits: MemoryHit[]
  candidates?: number
  shown?: number
  omitted?: number
  listingTruncated?: boolean
  text?: string
}

export interface MemorySearchQuery extends ScopeFields {
  query: string
  tracks?: Track[]
  includeArchive?: boolean
  limit?: number
}

/** `todo.list` row. Mirrors the mapped object in `modules/todo/rpc.ts`. */
export interface TodoItem {
  id: string
  track: TodoTrack
  text: string
  done: boolean
  important?: boolean
  urgent?: boolean
  due?: string | null
  overdue?: boolean
  createdAt?: string
  completedAt?: string | null
}

export interface TodoListValue {
  items: TodoItem[]
  lines?: string[]
  truncated: boolean
}

/** `scope` is NESTED here: todo's `scopeFromPayload` reads payload.scope.*. */
export interface TodoListQuery {
  tracks?: TodoTrack[]
  openOnly?: boolean
  scope?: { projectId?: string; cwd?: string }
}

/** `pending.list` row. Mirrors `PendingItem` in `src/host/types.ts`. */
export interface PendingProposal {
  track?: Track | TodoTrack
  content?: string
  text?: string
  title?: string
  body?: string
  category?: string
  importance?: number
  tags?: string[]
  branches?: string[]
  due?: string
  important?: boolean
  urgent?: boolean
  pid?: string
}

export interface PendingItem {
  id: string
  kind: string
  proposal: PendingProposal
  reason?: string
  fromSessionId?: string
  origin?: string
  createdAt: string
  status: 'pending' | 'approved' | 'rejected'
  decidedAt?: string
}

export interface PendingListValue {
  items: PendingItem[]
  truncated?: boolean
}

export interface PendingDecideResult {
  id?: string
  kind?: string
  status?: string
  entryId?: string
  todoId?: string
  promptId?: string
  message?: string
}

/** `logs.read` day row. The host clamps each day's text; `lines` is optional. */
export interface LogDay {
  date: string
  text: string
  lines?: number
}

export interface LogsReadValue {
  scope: 'project' | 'daily'
  days: LogDay[]
}

export interface LogsReadQuery {
  scope: 'project' | 'daily'
  date?: string
  lastDays?: number
  projectId?: string
}

/** `rooms.list` member row; `status` is the live agent state (`RoomMemberState`). */
export type RoomMemberState = 'running' | 'idle' | 'gone' | 'unknown'

export interface RoomMember {
  sessionId: string | null
  label: string
  status: RoomMemberState
  model?: string | null
  cwd?: string | null
  lastSeen?: string | null
  unread?: number
  joinedAt?: string
  lastActivityAt?: string | null
}

export interface RoomRow {
  id: string
  title: string
  lastSeq: number
  createdAt?: string
  createdBy?: string
  members: RoomMember[]
}

export interface RoomsListValue {
  rooms: RoomRow[]
}

export interface RoomMessage {
  seq: number
  from: string
  fromKind?: string
  text: string
  images?: string[]
  at?: string
}

export interface RoomsReadValue {
  messages: RoomMessage[]
  nextSeq?: number
  hasMore?: boolean
  total?: number
}

export interface RoomsStatusValue {
  members: RoomMember[]
  lastSeq?: number
  summary?: string
}

export interface RoomActionResult {
  room?: RoomRow | null
  message?: string
  seq?: number | null
  images?: string[]
  refused?: string[]
  counts?: Record<string, number> | null
}

/** `sessions.status` — the ONLY spawn gate the client trusts. */
export interface SessionsStatusValue {
  canSpawn: boolean
  reason?: string
  activeCount?: number
  spawnedByThisPlugin?: string[]
  live?: Array<{ sessionId: string; status: string; cwd?: string | null }>
}

export interface SpawnResult {
  sessionId: string | null
  message?: string
}

/** `jobs.list` row. */
export interface JobRow {
  id: string
  runner: string
  status: string
  startedAt?: string | number | null
  finishedAt?: string | number | null
  exitCode?: number | null
  summaryChars?: number
  taskChars?: number
  /** Auto-retry: how many retries have been attempted (0 = first run). */
  retryCount?: number
  /** Auto-retry: max retries allowed. */
  maxRetries?: number
  /** Auto-retry: ISO timestamp when the next retry is scheduled. */
  nextRetryAt?: string
  /** Why the most recent attempt failed. Present during the `queued` backoff
   * window, where `error` is cleared — so the row can show the reason. */
  lastError?: string
  /** Terminal failure reason, when the host reported one. */
  error?: string | null
}

export interface JobsListValue {
  jobs: JobRow[]
  activeCount?: number
}

/** `jobs.get` adds the detail fields; unknown extras are kept for display. */
export interface JobDetail extends JobRow {
  task?: string
  cwd?: string | null
  pid?: string | null
  sessionId?: string | null
  error?: string | null
  logPath?: string | null
  resultPath?: string | null
  writeBack?: string | null
  /** Auto-retry: id of the original job in the retry chain. */
  retryOf?: string
  /** Auto-retry: id of the next retry job if one was spawned. */
  retriedAs?: string
}

export interface JobLogsValue {
  stdout: string
  stderr: string
  truncated: boolean
}

/** Prompts are wave-2; every shape here is defensive (`unknown`-tolerant). */
export interface PromptRow {
  id: string
  title?: string
  body?: string
  category?: string | null
  enabled?: boolean
  createdAt?: string
  updatedAt?: string
  bodyChars?: number
  injected?: number
  used?: number
}

export interface PromptsListValue {
  prompts: PromptRow[]
  enabled?: boolean
}

// ------------------------------------------------------- decisions wire ----

/** One decision as it arrives on the wire (mirrors host `decisions.list`/`search`). */
export interface DecisionRow {
  id: string
  context: string
  options?: string[]
  chosen?: string
  rationale?: string
  owner?: string
  timestamp?: string
  pid?: string
  tags?: string[]
  linkedEntries?: string[]
}

export interface DecisionsListValue {
  decisions: DecisionRow[]
  total: number
  text: string
}

export interface DecisionsSearchValue {
  hits: DecisionRow[]
  total: number
  text: string
}

export interface ActionResult {
  ok?: boolean
  message?: string
  [key: string]: unknown
}

// ------------------------------------------------------------------- api ----

/** One call, typed at the boundary: `T` is the `value` shape, not the envelope. */
export interface CortexApi {
  ping(): Promise<CortexResult<PingValue>>
  /** `status.self` is wave-2 (M4/M7): an honest refusal is a valid answer. */
  statusSelf(): Promise<CortexResult<PingValue>>
  /** A write-channel probe that cannot mutate: an endpoint the dispatcher rejects. */
  probeWriteChannel(endpoint: string): Promise<CortexResult<unknown>>

  memoryList(query?: MemoryListQuery): Promise<CortexResult<MemoryListValue>>
  memorySearch(query: MemorySearchQuery): Promise<CortexResult<MemorySearchValue>>
  memoryArchive(id: string): Promise<CortexResult<ActionResult>>
  memoryRestore(id: string): Promise<CortexResult<ActionResult>>
  memoryDelete(id: string): Promise<CortexResult<ActionResult>>
  pendingList(status?: 'pending' | 'approved' | 'rejected'): Promise<CortexResult<PendingListValue>>
  pendingApprove(id: string): Promise<CortexResult<PendingDecideResult>>
  pendingReject(id: string, reason?: string): Promise<CortexResult<PendingDecideResult>>

  todoList(query?: TodoListQuery): Promise<CortexResult<TodoListValue>>
  todoAdd(input: {
    track: TodoTrack
    text: string
    important?: boolean
    urgent?: boolean
    due?: string
    scope?: { projectId?: string; cwd?: string }
  }): Promise<CortexResult<TodoItem>>
  todoComplete(id: string, scope?: CortexScope): Promise<CortexResult<ActionResult>>
  todoRemove(id: string, scope?: CortexScope): Promise<CortexResult<ActionResult>>
  todoUncomplete(id: string, scope?: CortexScope): Promise<CortexResult<ActionResult>>

  logsRead(query: LogsReadQuery): Promise<CortexResult<LogsReadValue>>

  roomsList(): Promise<CortexResult<RoomsListValue>>
  roomsRead(roomId: string, sinceSeq?: number, limit?: number): Promise<CortexResult<RoomsReadValue>>
  roomsStatus(roomId: string): Promise<CortexResult<RoomsStatusValue>>
  roomsCreate(title: string, author?: RoomAuthor): Promise<CortexResult<RoomActionResult>>
  roomsPost(roomId: string, text: string, author?: RoomAuthor): Promise<CortexResult<RoomActionResult>>
  roomsSpawn(input: { roomId: string; label: string; prompt: string; model?: string }): Promise<CortexResult<SpawnResult>>

  sessionsStatus(): Promise<CortexResult<SessionsStatusValue>>

  jobsList(limit?: number): Promise<CortexResult<JobsListValue>>
  jobsGet(jobId: string): Promise<CortexResult<JobDetail>>
  jobsLogs(jobId: string, tailBytes?: number): Promise<CortexResult<JobLogsValue>>
  jobsCancel(jobId: string): Promise<CortexResult<ActionResult>>
  jobsRetry(jobId: string): Promise<CortexResult<ActionResult>>

  promptsList(): Promise<CortexResult<PromptsListValue>>
  promptsGet(id: string): Promise<CortexResult<PromptRow>>

  decisionsList(limit?: number): Promise<CortexResult<DecisionsListValue>>
  decisionsSearch(query: string, pid?: string): Promise<CortexResult<DecisionsSearchValue>>
  decisionsLink(id: string, entryIds: string[]): Promise<CortexResult<ActionResult>>

  boardsList(roomId: string): Promise<CortexResult<BoardsListValue>>
  boardsGet(roomId: string, boardId: string, options?: { includeComments?: boolean }): Promise<CortexResult<BoardsGetValue>>
  boardsCreate(input: { roomId: string; title: string }): Promise<CortexResult<BoardCardAction>>
  boardsAddCard(input: {
    roomId: string
    boardId: string
    title: string
    description?: string
    status?: BoardStatus
    ownerId?: string
    dependencies?: string[]
  }): Promise<CortexResult<BoardCardAction>>
  boardsMoveCard(input: { roomId: string; boardId: string; cardId: string; status: BoardStatus }): Promise<CortexResult<BoardCardAction>>
  boardsComment(input: { roomId: string; boardId: string; cardId: string; text: string }): Promise<CortexResult<BoardCommentAction>>
  boardsDelete(input: { roomId: string; boardId: string }): Promise<CortexResult<ActionResult>>
}

/** Anything JSON-ish that came back over the transport. */
type RawEnvelope = { ok?: unknown; value?: unknown; error?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function codeOf(error: Record<string, unknown>, fallback: string): string {
  const code = error.code
  return typeof code === 'string' && code !== '' ? code : fallback
}

/**
 * The PLUGIN's code for a refusal, recovered from the wire.
 *
 * The host owns `error.code`: it parses every reply against a 40-member union
 * and THROWS on anything else, so a code like `unknown-endpoint` cannot travel
 * in that field. The host side projects ours onto a code in its own vocabulary
 * and preserves the original as a leading `[code]` in the message, which it does
 * not police; this reads that back.
 *
 * Anything that branches on a specific refusal — the prompts "not mounted"
 * state, both settings health lines — must come through here and never read
 * `error.code` directly, or it silently starts matching the host's
 * `bad-request` for every plugin refusal.
 */
export function pluginErrorCode(error: { code: string; message: string }): string {
  return /^\[([a-z][a-z-]*)\]/.exec(error.message)?.[1] ?? error.code
}

function messageOf(error: Record<string, unknown>): string {
  const message = error.message ?? error.error ?? error
  const text = typeof message === 'string' ? message : JSON.stringify(message) ?? String(message)
  // A transport message can carry a stack; the panel is a text node, so a long
  // one is truncated rather than dropped.
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/**
 * Envelope unwrap. Accepts the host's `{ok,error:{code,message}}` and the
 * looser `{ok:false,error:'string'}` a transport middleware can produce, plus a
 * bare value (no envelope) so an older host still renders.
 */
export function unwrap<T>(raw: unknown): CortexResult<T> {
  if (isRecord(raw) && ('ok' in raw || 'error' in raw || 'value' in raw)) {
    const env = raw as RawEnvelope
    if (env.ok === true) return { ok: true, value: env.value as T }
    if (env.ok === false) {
      const error = isRecord(env.error) ? env.error : { message: env.error }
      return { ok: false, error: { code: codeOf(error, 'rpc-error'), message: messageOf(error) } }
    }
    // `{value}` or `{error}` without `ok`: answer from what is actually there.
    if ('value' in env) return { ok: true, value: env.value as T }
    const error = isRecord(env.error) ? env.error : { message: env.error }
    return { ok: false, error: { code: codeOf(error, 'rpc-error'), message: messageOf(error) } }
  }
  return { ok: true, value: raw as T }
}

/** Flatten a `scope` object into the payload fields the host handlers read. */
export function withScope<T extends object>(payload: T, scope?: CortexScope): T & ScopeFields {
  return { ...payload, ...scopeFields(scope) }
}

/** Nested form, for handlers that read `payload.scope.{projectId,cwd}` (todo). */
export function nestedScope<T extends object>(payload: T, scope?: CortexScope): T & { scope?: Record<string, string> } {
  const flat = scopeFields(scope)
  const inner: Record<string, string> = {}
  if (flat.projectId !== undefined) inner.projectId = flat.projectId
  if (flat.cwd !== undefined) inner.cwd = flat.cwd
  return Object.keys(inner).length === 0 ? payload : { ...payload, scope: inner }
}

/**
 * A room write needs an AUTHOR, not a project: there is no caller session on an
 * RPC call, so the host takes `sessionId`/`label` from the payload and says so
 * in the result (`modules/rooms/rpc.ts` header). Without either, the post is
 * attributed `system`/'ui' — which is honest, so it is what v1 does by default.
 */
export interface RoomAuthor {
  sessionId?: string
  label?: string
}

function authorFields(author?: RoomAuthor): Record<string, string> {
  if (author === undefined) return {}
  return {
    ...(typeof author.sessionId === 'string' && author.sessionId !== '' ? { sessionId: author.sessionId } : {}),
    ...(typeof author.label === 'string' && author.label !== '' ? { label: author.label } : {}),
  }
}

/** A call that never resolved, never answered: a typed failure, not a hang. */
export function failure(code: string, message: string): CortexResult<never> {
  return { ok: false, error: { code, message } }
}

const DEFAULT_TIMEOUT_MS = 20_000

/** Race a call against a timer + abort so a wedged host cannot freeze a tab. */
async function guarded<T>(
  call: RpcCall,
  channel: string,
  endpoint: string,
  payload: unknown,
  timeoutMs: number,
): Promise<CortexResult<T>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reply = await Promise.race([
      call(channel, endpoint, payload, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
      }),
    ])
    return unwrap<T>(reply)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failure(detail.includes('timed out') ? 'timeout' : 'transport', detail)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // A resolved-after-timeout call must not keep the socket half-open.
    controller.abort()
  }
}

export interface CortexApiOptions {
  /** Abort signal source for long queries; reserved for per-tab cancellation. */
  timeoutMs?: number
}

/**
 * Build the typed API over any transport. The mock adapter satisfies the same
 * `RpcCall` signature, which is why the panel can be mounted on fixtures.
 */
export function createCortexApi(call: RpcCall, options: CortexApiOptions = {}): CortexApi {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const read = <T>(endpoint: string, payload: unknown = {}): Promise<CortexResult<T>> =>
    guarded<T>(call, CORTEX_READ_CHANNEL, endpoint, payload, timeoutMs)
  const write = <T>(endpoint: string, payload: unknown): Promise<CortexResult<T>> =>
    guarded<T>(call, CORTEX_WRITE_CHANNEL, endpoint, payload, timeoutMs)

  return {
    ping: () => read<PingValue>(CORTEX_PING_ENDPOINT, {}),
    statusSelf: () => read<PingValue>('status.self', {}),
    probeWriteChannel: endpoint => write<unknown>(endpoint, { probe: true }),

    memoryList: query => read<MemoryListValue>('memory.list', withScope({ ...(query ?? {}) })),
    memorySearch: query => read<MemorySearchValue>('memory.search', withScope({ ...query })),
    memoryArchive: id => write<ActionResult>('memory.archive', { id }),
    memoryRestore: id => write<ActionResult>('memory.restore', { id }),
    memoryDelete: async id => {
      const first = await write<ActionResult>('memory.delete', { id })
      if (first.ok === true) {
        const tok = (first.value as { token?: string } | undefined)?.token
        if (typeof tok === 'string' && tok.length > 0) {
          return write<ActionResult>('memory.delete', { id, confirm: tok })
        }
      }
      return first
    },
    pendingList: status => read<PendingListValue>('pending.list', status === undefined ? {} : { status }),
    pendingApprove: id => write<PendingDecideResult>('pending.approve', { id }),
    pendingReject: id => write<PendingDecideResult>('pending.reject', { id }),

    todoList: query => read<TodoListValue>('todo.list', { ...(query ?? {}) }),
    todoAdd: input => write<TodoItem>('todo.add', { ...input }),
    // `todo.add` is the human path: it writes immediately, no pending queue.
    todoComplete: (id, scope) => write<ActionResult>('todo.complete', nestedScope({ id }, scope)),
    todoRemove: (id, scope) => write<ActionResult>('todo.remove', nestedScope({ id }, scope)),
    // v1 has no todo.uncomplete endpoint: reopening a done row re-adds the text.
    todoUncomplete: (id, scope) => write<ActionResult>('todo.complete', nestedScope({ id, done: false }, scope)),

    logsRead: query => read<LogsReadValue>('logs.read', { ...query }),

    roomsList: () => read<RoomsListValue>('rooms.list', {}),
    roomsRead: (roomId, sinceSeq, limit) =>
      read<RoomsReadValue>('rooms.read', {
        roomId,
        ...(sinceSeq === undefined ? {} : { sinceSeq }),
        ...(limit === undefined ? {} : { limit }),
      }),
    roomsStatus: roomId =>
      read<RoomsStatusValue>('rooms.status', { roomId }).then(result =>
        result.ok === false ? result : { ok: true as const, value: normalizeRoomStatus(result.value) },
      ),
    roomsCreate: (title, author) => write<RoomActionResult>('rooms.create', { title, ...authorFields(author) }),
    roomsPost: (roomId, message, author) =>
      write<RoomActionResult>('rooms.post', { roomId, text: message, ...authorFields(author) }),
    roomsSpawn: input => write<SpawnResult>('rooms.spawn', { ...input }),

    sessionsStatus: () => read<SessionsStatusValue>('sessions.status', {}),

    jobsList: limit => {
      // The host answers `jobs.list` with a bare array; accept either shape.
      return read<JobsListValue | JobRow[]>('jobs.list', limit === undefined ? {} : { limit }).then(result =>
        result.ok === false
          ? result
          : { ok: true as const, value: normalizeJobs(result.value) },
      )
    },
    jobsGet: jobId => read<JobDetail>('jobs.get', { jobId }),
    jobsLogs: (jobId, tailBytes) =>
      read<JobLogsValue>('jobs.logs', { jobId, ...(tailBytes === undefined ? {} : { tailBytes }) }),
    jobsCancel: jobId => write<ActionResult>('jobs.cancel', { jobId }),
    jobsRetry: jobId => write<ActionResult>('jobs.retry', { jobId }),

    promptsList: () => read<PromptsListValue>('prompts.list', {}),
    promptsGet: id => read<PromptRow>('prompts.get', { id }),

    decisionsList: limit =>
      read<DecisionsListValue>('decisions.list', limit === undefined ? {} : { limit }).then(result =>
        result.ok === false ? result : { ok: true as const, value: normalizeDecisionsList(result.value) },
      ),
    decisionsSearch: (query, pid) =>
      read<DecisionsSearchValue>('decisions.search', { query, ...(pid === undefined ? {} : { pid }) }).then(result =>
        result.ok === false ? result : { ok: true as const, value: normalizeDecisionsSearch(result.value) },
      ),
    decisionsLink: (id, entryIds) => write<ActionResult>('decisions.link', { id, entryIds }),

    boardsList: roomId => read<BoardsListValue>('boards.list', { roomId }),
    boardsGet: (roomId, boardId, options) =>
      read<BoardsGetValue>('boards.get', {
        roomId,
        boardId,
        ...(options?.includeComments ? { includeComments: true } : {}),
      }),
    boardsCreate: input => write<BoardCardAction>('boards.create', input),
    boardsAddCard: input => write<BoardCardAction>('boards.addCard', input),
    boardsMoveCard: input => write<BoardCardAction>('boards.moveCard', input),
    boardsComment: input => write<BoardCommentAction>('boards.comment', input),
    boardsDelete: input => write<ActionResult>('boards.delete', input),
  }
}

/**
 * `rooms.status` rows carry the live state under `state` (`RoomService.status()`
 * in modules/rooms/service.ts) while `rooms.list` members carry `status`. One
 * shape for the UI: normalize to `status`, and keep unknown values as
 * 'unknown' rather than inventing one.
 */
export function normalizeRoomStatus(value: RoomsStatusValue): RoomsStatusValue {
  const members = Array.isArray(value?.members) ? value.members : []
  return {
    ...value,
    members: members.map(member => {
      const row = member as RoomMember & { state?: unknown }
      const status = roomStateOf(row.status ?? row.state)
      return { ...member, status, ...(row.state === undefined ? {} : { state: status }) } as RoomMember
    }),
  }
}

const ROOM_STATES: readonly RoomMemberState[] = ['running', 'idle', 'gone', 'unknown']

export function roomStateOf(value: unknown): RoomMemberState {
  return (ROOM_STATES as readonly string[]).includes(String(value)) ? (value as RoomMemberState) : 'unknown'
}

/** `jobs.list` → `{jobs}` (contract) or a bare array (current host handler). */
export function normalizeJobs(raw: JobsListValue | JobRow[] | unknown): JobsListValue {
  if (Array.isArray(raw)) return { jobs: raw as JobRow[] }
  if (isRecord(raw) && Array.isArray(raw.jobs)) return { ...(raw as unknown as JobsListValue) }
  return { jobs: [] }
}

// --------------------------------------------------------------- decisions ----

/**
 * The host contract is `{decisions, total, text}`, but an older or reduced
 * host may answer a bare array. Accept both and always return the contract
 * shape so the panel never branches on the transport.
 */
export function normalizeDecisionsList(raw: unknown): DecisionsListValue {
  if (Array.isArray(raw)) return { decisions: raw as DecisionRow[], total: raw.length, text: '' }
  if (isRecord(raw) && Array.isArray(raw.decisions)) {
    return {
      decisions: raw.decisions as DecisionRow[],
      total: typeof raw.total === 'number' ? raw.total : (raw.decisions as DecisionRow[]).length,
      text: typeof raw.text === 'string' ? raw.text : '',
    }
  }
  return { decisions: [], total: 0, text: '' }
}

/** `decisions.search` → `{hits, total, text}` or a bare array. */
export function normalizeDecisionsSearch(raw: unknown): DecisionsSearchValue {
  if (Array.isArray(raw)) return { hits: raw as DecisionRow[], total: raw.length, text: '' }
  if (isRecord(raw) && Array.isArray(raw.hits)) {
    return {
      hits: raw.hits as DecisionRow[],
      total: typeof raw.total === 'number' ? raw.total : (raw.hits as DecisionRow[]).length,
      text: typeof raw.text === 'string' ? raw.text : '',
    }
  }
  return { hits: [], total: 0, text: '' }
}

// ------------------------------------------------------------------- board ----

export type BoardStatus = 'backlog' | 'in-progress' | 'done'

export interface BoardCard {
  id: string
  title: string
  status: BoardStatus
  owner?: string | null
  dependencies: string[]
  createdAt: string
  updatedAt: string
  description?: string
}

export interface BoardComment {
  id: string
  cardId: string
  author: string | null
  text: string
  at: string
}

export interface BoardRow {
  id: string
  title: string
  cardCount: number
  createdAt: string
}

export interface BoardsListValue {
  boards: BoardRow[]
}

export interface BoardsGetValue {
  cards: BoardCard[]
  comments: BoardComment[]
}

export interface BoardCardAction {
  id?: string
  title?: string
  status?: BoardStatus
  owner?: string | null
  dependencies?: string[]
  createdAt?: string
  updatedAt?: string
}

export interface BoardCommentAction {
  id?: string
  cardId?: string
  author?: string | null
  text?: string
  at?: string
}
