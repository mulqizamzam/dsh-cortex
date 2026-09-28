/**
 * The dsh-cortex data contract: DESIGN §2 (model) and §7 (config), mirrored
 * exactly. M2..M6 import types from here — additions are fine, shape changes
 * are a contract break.
 */
import type { CortexCaps } from '../lib/caps.ts'
import type { HostContextShape } from './dsh.ts'
import type { CortexStore } from './store.ts'
import type { CortexResult } from '../lib/errors.ts'

export type { CortexCaps, CortexResult }

/** Result envelope returned by every public store method (no method throws). */
export type StoreResult<T> = CortexResult<T>

/** Memory tracks (DESIGN §2). */
export type Track = 'user' | 'global' | 'project'
/** Who authored an entry; `ai-confirmed` = AI wrote it on explicit user order. */
export type EntryOrigin = 'user' | 'ai-confirmed' | 'import'
/** Todo tracks: three life buckets plus the project bucket (DESIGN §4). */
export type TodoTrack = 'life' | 'work' | 'daily' | 'project'

export interface EntrySource {
  sessionId?: string
  quote?: string
}

/** One memory entry = one file `…/entries/<id>.json`. */
export interface Entry {
  id: string
  track: Track
  /** Capped on write by `caps.entryChars` (P2). */
  content: string
  /** 1..5; ties break by age when a render budget is exceeded. */
  importance: number
  tags: string[]
  /** Structured scope (P8): absent/empty = every branch. */
  branches?: string[]
  createdAt: string
  updatedAt: string
  origin: EntryOrigin
  source?: EntrySource
  /** Set on archive copies; stripped on restore. */
  archivedAt?: string
  /** Carried by project-track entries so a renderer can re-key them. */
  pid?: string
}

export interface TodoItem {
  id: string
  track: TodoTrack
  text: string
  done: boolean
  important?: boolean
  urgent?: boolean
  /** `YYYY-MM-DD`. */
  due?: string
  createdAt: string
  completedAt?: string
}

/** One appended log line and where it landed. */
export interface LogRef {
  scope: 'project' | 'daily'
  pid?: string
  date: string
  line: string
  /** True when the day cap rolled the write into a `<date>-2.md` sibling. */
  rolled?: boolean
}

/** An AI proposal awaiting a human decision (DESIGN §4 pending queue). */
export interface PendingItem {
  id: string
  kind: 'memory' | 'todo' | 'prompt'
  proposal: {
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
    /** Project-scope id so a project proposal can be approved WITHOUT the panel
     * re-supplying projectId/cwd (parent ruling, M2 report C.0.2). */
    pid?: string
  }
  reason?: string
  fromSessionId?: string
  createdAt: string
  status: 'pending' | 'approved' | 'rejected'
  decidedAt?: string
}

export interface PromptDoc {
  id: string
  title: string
  body: string
  category?: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** One row of `inject/<sessionId>.json`. */
export interface InjectQueueItem {
  promptId: string
  mode: 'once' | 'sticky'
  at: string
}

export interface InjectQueue {
  sessionId: string
  items: InjectQueueItem[]
  updatedAt: string
}

export type RoomMemberState = 'running' | 'idle' | 'gone' | 'unknown'

export interface RoomMember {
  sessionId?: string
  label: string
  model?: string
  cwd?: string
  state: RoomMemberState
  joinedAt: string
  lastActivityAt?: string
}

export interface Room {
  id: string
  title: string
  members: RoomMember[]
  createdBy: string
  createdAt: string
  /** Highest published sequence (mirrors `seq.txt`). */
  lastSeq: number
}

export type RoomMessageAuthor = 'user' | 'session' | 'system'

export interface RoomMessage {
  seq: number
  roomId: string
  fromSessionId?: string
  fromKind: RoomMessageAuthor
  fromLabel?: string
  text: string
  /** Paths relative to `rooms/<roomId>/` (e.g. `images/<file>`). */
  images: string[]
  at: string
  jobId?: string
}

/** `'lost'` = a job still marked `running` when the host restarted; the module flips
 * these on boot (parent ruling, M6 report — orphan recovery, honest terminal state).
 * `'dead-letter'` = a job that failed and exhausted all automatic retries. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed' | 'timeout' | 'lost' | 'dead-letter'

export interface Job {
  id: string
  runner: string
  /** Resolved from the config runner registry — never built from user text (P7). */
  argv: string[]
  task: string
  status: JobStatus
  cwd?: string
  roomId?: string
  pid?: string
  /** Project id captured at dispatch (resolveProjectId) and persisted via the
   * updateJob spread (store.createJob drops unknown fields). Formalised here so
   * the delegate module no longer needs a local widened type (parent, M6 report). */
  projectId?: string
  sessionId?: string
  startedAt: string
  finishedAt?: string
  exitCode?: number | null
  error?: string
  /** Auto-retry: how many times this job has been retried (0 = first attempt). */
  retryCount?: number
  /** Auto-retry: max retries allowed for this job (snapshotted from config at dispatch). */
  maxRetries?: number
  /** Auto-retry: ISO timestamp when the next retry will fire (set during backoff wait). */
  nextRetryAt?: string
  /** Auto-retry: id of the original job if this is a retry (retry chain tracking). */
  retryOf?: string
  /** Auto-retry: id of the next retry job if this triggered one (chain tracking). */
  retriedAs?: string
}

/** Project directory metadata, `projects/<pid>/meta.json`. */
export interface ProjectMeta {
  pid: string
  remoteUrl?: string
  cwdHistory: string[]
  createdAt: string
}

export interface InjectConfig {
  enabled: boolean
  user: boolean
  global: boolean
  project: boolean
  todo: boolean
}

export interface RunnerSpec {
  /** Executable + fixed args; the task text is appended as the last argv item. */
  argv: string[]
  description: string
  /** Seconds; `0` means "use `delegation.jobTimeoutSec`". */
  timeoutSec: number
  env: Record<string, string>
}

export interface DelegationConfig {
  enabled: boolean
  runners: Record<string, RunnerSpec>
  maxConcurrent: number
  jobTimeoutSec: number
  outputCapBytes: number
  /** Auto-retry on failure (failed/timeout); 0 = no auto-retry. Killed/cancelled jobs are NOT retried. */
  retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number }
}

/** The user-editable config (DESIGN §7) plus the `stateRoot` override. */
export interface CortexConfig {
  /** '' = `<DSH_HOME>/dsh-cortex` via the host home-path service. */
  stateRoot: string
  inject: InjectConfig
  memory: { autoAccept: boolean }
  /** Namespace kept for forward-compatible config; currently holds no user knobs. */
  pending: Record<string, never>
  rooms: { enabled: boolean }
  prompts: { enabled: boolean }
  delegation: DelegationConfig
  caps: CortexCaps
  retention: { dailyLogDays: number }
  /** G-06 nudge interval; everyTurns 0 = off (promoted by parent per M3 request).
   * Optional in the TYPE because defensive readers (M3 everyTurnsOf) treat an
   * ABSENT block as off — resolveConfig always fills it; user patches may omit it. */
  logReview?: { everyTurns: number }
  /** Handoff Protocol: auto-prepend a structured context block to spawn prompts. */
  handoff?: { enabled: boolean }
  /** Inter-agent task board (rooms only; cards, dependencies, comments). */
  board?: { enabled: boolean }
}

/** Fully-defaulted config as modules see it. `injectLabel` is the P1 header. */
export type ResolvedConfig = CortexConfig & { readonly injectLabel: string }

/** Module wiring status, surfaced by `cortex_status`. */
export interface ModuleStatus {
  name: string
  state: 'ok' | 'failed' | 'skipped'
  error?: string
  tools: string[]
}

/** Read-only wiring view. */
export interface CortexRuntimeView {
  modules: readonly ModuleStatus[]
  bootError?: string
  errors?: string[]
}

/** The only surface a module may depend on. */
export interface ModuleDeps {
  ctx: HostContextShape
  /** Live config reader: CALL per use, never destructure at mount. */
  cfg(): ResolvedConfig
  store: CortexStore
  log(message: string): void
  warn(message: string): void
  runtime(): CortexRuntimeView
}

/** Board column status for the inter-agent task board. */
export type BoardStatus = 'backlog' | 'in-progress' | 'done'

/** One card on a board: owned by one session, with dependencies and comments. */
export interface BoardCard {
  id: string
  boardId: string
  /** Human-readable summary of the work. */
  title: string
  /** Optional longer description. */
  description?: string
  /** Which column the card currently lives in. */
  status: BoardStatus
  /** Session id of the agent who owns this card. */
  ownerId?: string
  /** Ids of other cards in the same board that must be done first. */
  dependencies: string[]
  createdAt: string
  updatedAt: string
}

/** One comment on a board card — a session or the UI can post it. */
export interface BoardComment {
  id: string
  cardId: string
  /** Session id of the author; absent for UI / system posts. */
  authorSessionId?: string
  /** Short label shown instead of a raw session id. */
  authorLabel?: string
  text: string
  createdAt: string
}

/** One board belongs to one room; holds the list of card ids plus metadata. */
export interface Board {
  id: string
  roomId: string
  title: string
  /** Ordered list of card ids (may contain ids no longer present on disk). */
  cardIds: string[]
  createdAt: string
  updatedAt: string
}

/** One feature module (M2..M6). `apply` throwing only costs that module its wiring. */
export interface CortexModule {
  name: string
  apply(deps: ModuleDeps): void
}

/** A structured decision record parsed from [decision] tagged log lines. */
export interface Decision {
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
}
