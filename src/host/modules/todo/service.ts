/**
 * The tasks service: store access, project scoping, and the SYNCHRONOUS digest
 * cache that feeds the `cortex:todo` injection seam.
 *
 * Why a cache (host source, not the doc): `SystemPrompt.context()` accepts
 * `text: string | ((context: AssembleContext) => string)`
 * (`/home/administrator/deepseek-harness/packages/core/system-prompt/src/index.ts:67,398`)
 * — the provider is evaluated synchronously at every assembly. All state reads
 * here are async, so the seam can only ever return the last computed snapshot.
 * Snapshots are therefore (re)loaded:
 *   - at mount and on `agent/created` (warm-up for the session's own scope),
 *   - immediately after any todo write made through this module,
 *   - whenever the cached snapshot is older than `DIGEST_TTL_MS`, refreshed in
 *     the background (the current call still returns the previous snapshot).
 * A snapshot that has never loaded contributes `''`: an empty block is honest,
 * a stale-but-labelled one is not faked, and we never render a summary the
 * store did not give us (DESIGN §9.1 G-06 spirit).
 */
import { isSafeKey, isoDate } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { HostAgent } from '../../dsh.ts'
import type { ModuleDeps, TodoItem, TodoTrack } from '../../types.ts'
import { TODO_CONTEXT_NAME, TODO_CONTEXT_ORDER, parseDue, renderTodoDigest } from './digest.ts'
import type { DigestResult } from './digest.ts'
import { safePid, sharedTaskScopes, cwdOf, scopeKeyOf } from './scope.ts'
import type { TaskScopeCache } from './scope.ts'
import type { TaskScope } from './scope.ts'

/** How long a digest snapshot may serve before it is reloaded in the background. */
export const DIGEST_TTL_MS = 20_000

/** Tracks the AI may address; `project` needs a resolved scope. */
export const ADDABLE_TRACKS: readonly TodoTrack[] = ['life', 'work', 'daily', 'project']

export interface TodoWriteResult {
  ok: boolean
  /** Model-visible sentence (already neutralized by the caller's render edge). */
  message: string
  item?: TodoItem
}

type Args = Record<string, unknown>

function refusal(message: string): TodoWriteResult {
  return { ok: false, message: neutralize(message) }
}

/** Coerce a payload/UI string into a known todo track. */
export function toTrack(value: unknown): TodoTrack | undefined {
  return (ADDABLE_TRACKS as readonly string[]).includes(typeof value === 'string' ? value : '')
    ? (value as TodoTrack)
    : undefined
}

/** Read `scope.projectId` / `scope.cwd` from an RPC payload (RPC-ENDPOINTS §scope). */
export function scopeFromPayload(payload: Args): { pid?: string; cwd?: string } {
  const raw = payload.scope
  if (raw === null || typeof raw !== 'object') return {}
  const scope = raw as { projectId?: unknown; cwd?: unknown }
  const pid = typeof scope.projectId === 'string' && isSafeKey(scope.projectId) ? scope.projectId : undefined
  const cwd = typeof scope.cwd === 'string' && scope.cwd.trim() !== '' ? scope.cwd.trim() : undefined
  return { ...(pid === undefined ? {} : { pid }), ...(cwd === undefined ? {} : { cwd }) }
}

export interface TodoServiceOptions {
  deps: ModuleDeps
  /** Injectable so tests never need a git binary. */
  scopes?: TaskScopeCache
  now?: () => Date
}

/** One digest snapshot per scope key. */
interface Snapshot {
  at: number
  text: string
  open: number
  overdue: number
  /** The scope this snapshot was loaded for, so a write can reload it. */
  pid?: string
}

/**
 * Owns the todo tools, the RPC endpoint handlers and the injection seam. The
 * module file (`index.ts`) is the only caller; it constructs one instance.
 */
export class TodoService {
  readonly deps: ModuleDeps
  readonly scopes: TaskScopeCache
  private readonly clock: () => Date
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly loading = new Map<string, Promise<Snapshot>>()
  private disposers: Array<() => void> = []
  private seamInstalled = false

  constructor(options: TodoServiceOptions) {
    this.deps = options.deps
    this.scopes = options.scopes ?? sharedTaskScopes()
    this.clock = options.now ?? ((): Date => new Date())
  }

  get store() {
    return this.deps.store
  }

  /** Today as the store sees it (`YYYY-MM-DD`, local). */
  today(): string {
    return isoDate(this.clock())
  }

  // ------------------------------------------------------------- scoping ----
  /** Resolve the caller's project scope; `pid` is absent outside a known repo. */
  async scopeFor(agent: unknown): Promise<TaskScope> {
    return await this.scopes.resolve(cwdOf(agent))
  }

  // ------------------------------------------------------------- queries ----
  /** Open items for a scope: the three life buckets plus the project bucket. */
  async openTodos(pid?: string): Promise<TodoItem[]> {
    const result = await this.store.listTodos(pid ? { pid, openOnly: true } : { openOnly: true })
    return result.ok ? result.data : []
  }

  async allTodos(options: { pid?: string; tracks?: TodoTrack[]; openOnly?: boolean }): Promise<TodoItem[]> {
    const result = await this.store.listTodos({
      ...(options.tracks === undefined ? {} : { tracks: options.tracks }),
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.openOnly === undefined ? {} : { openOnly: options.openOnly }),
    })
    return result.ok ? result.data : []
  }

  // -------------------------------------------------------------- digest ----
  /**
   * The `cortex:todo` text provider. Runs on every prompt assembly, so it must
   * never await, never throw, and never invent: it renders the newest snapshot
   * for the calling session's scope and refreshes it in the background.
   */
  contextText = (context: unknown): string => {
    try {
      const config = this.deps.cfg()
      if (config.inject.enabled !== true || config.inject.todo !== true) return ''
      const agent = (context as { agent?: unknown } | undefined)?.agent
      const cwd = cwdOf(agent)
      const known = this.scopes.peek(cwd)
      const pid = known?.pid
      const key = scopeKeyOf(pid)
      if (cwd !== undefined && known === undefined) void this.warm(cwd)
      const hit = this.snapshots.get(key)
      if (hit === undefined || this.clock().getTime() - hit.at > DIGEST_TTL_MS) void this.loadDigest(key, pid)
      return hit?.text ?? ''
    } catch (error) {
      // A failed render costs the session its todo block, never the turn (P4).
      this.deps.warn(`todo: digest render failed: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** Refresh one scope snapshot (deduped; failures leave the old snapshot). */
  loadDigest(key: string, pid?: string): Promise<Snapshot> {
    const running = this.loading.get(key)
    if (running !== undefined) return running
    const task = (async (): Promise<Snapshot> => {
      const previous = this.snapshots.get(key)
      let items: TodoItem[]
      try {
        items = await this.openTodos(pid)
      } catch (error) {
        // A failed read keeps the old snapshot and says so; the seam never
        // rejects, so no caller can leak an unhandled rejection (P4).
        this.deps.warn(`todo: digest read failed: ${error instanceof Error ? error.message : String(error)}`)
        return previous ?? { at: this.clock().getTime(), text: '', open: 0, overdue: 0 }
      }
      const rendered: DigestResult = renderTodoDigest({
        items,
        label: this.deps.cfg().injectLabel,
        budget: this.deps.cfg().caps.todoDigestChars,
        today: this.today(),
        ...(pid === undefined ? {} : { projectName: `project ${pid.slice(0, 8)}…` }),
      })
      const snapshot: Snapshot = {
        at: this.clock().getTime(),
        text: rendered.text,
        open: rendered.shown + rendered.omitted,
        overdue: rendered.overdue,
        ...(pid === undefined ? {} : { pid }),
      }
      this.snapshots.set(key, snapshot)
      if (rendered.suppressed && rendered.text === '') {
        this.deps.warn(`todo: digest budget ${String(this.deps.cfg().caps.todoDigestChars)} too small to carry the label; block suppressed`)
      }
      return snapshot
    })()
    this.loading.set(key, task)
    void task.then(() => undefined, () => undefined).finally(() => this.loading.delete(key))
    return task
  }

  /** Resolve the scope for a cwd and load its digest (warm-up path). */
  async warm(cwd: string | undefined): Promise<Snapshot> {
    const scope = await this.scopes.resolve(cwd)
    return await this.loadDigest(scopeKeyOf(scope.pid), scope.pid)
  }

  /**
   * Drop every snapshot AND reload the scopes we were serving, in the
   * background. A write must not cost the session its next digest: the row is
   * cleared so no stale text can be read, then repopulated as soon as the
   * store answers (the assembly in flight still renders the previous text or
   * nothing — never a half-truth).
   */
  invalidate(): void {
    const loaded = [...this.snapshots.entries()]
    this.snapshots.clear()
    for (const [key, snapshot] of loaded) {
      void this.loadDigest(key, snapshot.pid).then(() => undefined, () => undefined)
    }
  }

  /** Number of live snapshots (test seam). */
  get snapshotCount(): number {
    return this.snapshots.size
  }

  /**
   * Await every in-flight snapshot reload. Tests use it to observe a settled
   * cache; the runtime path never needs to (writes refresh in the background).
   */
  async settle(): Promise<void> {
    for (let pass = 0; pass < 5; pass += 1) {
      const pending = [...this.loading.values()]
      if (pending.length === 0) return
      await Promise.all(pending.map(task => task.then(() => undefined, () => undefined)))
    }
  }

  // ------------------------------------------------------------- mutations --
  /** The human/UI path and the AI path share this: validation, then the store. */
  async addTodo(args: Args, agent: unknown): Promise<TodoWriteResult> {
    const track = toTrack(args.track)
    if (track === undefined) return refusal('track must be one of life, work, daily, project')
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text === '') return refusal('text is required: what needs doing, in one line')
    const due = parseDue(args.due)
    if (!due.ok) return refusal(due.error)
    // An explicit projectId is only honoured when it is a store-safe key: the
    // store joins the pid straight into a path, so a `../` id is refused here
    // rather than silently reinterpreted as "whatever this session is in" (P5).
    if (args.pid !== undefined && safePid(args.pid) === undefined) {
      return refusal('pid is not a valid project id: pass the id the panel read back, or none at all')
    }
    let pid: string | undefined
    // A well-formed projectId (the UI path, where there is no session to inherit
    // a repo from) wins over a probe.
    const explicit = safePid(args.pid)
    if (track === 'project') {
      if (explicit !== undefined) pid = explicit
      else {
        const scope = await this.scopeFor(agent)
        if (scope.pid === undefined) {
          return refusal('project todos need a session working directory inside a project; use track "life", "work" or "daily" instead')
        }
        pid = scope.pid
      }
    }
    const important = typeof args.important === 'boolean' ? args.important : undefined
    const urgent = typeof args.urgent === 'boolean' ? args.urgent : undefined
    const result = await this.store.addTodo({
      track,
      text,
      ...(pid === undefined ? {} : { pid }),
      ...(important === undefined ? {} : { important }),
      ...(urgent === undefined ? {} : { urgent }),
      ...(due.due === undefined ? {} : { due: due.due }),
    })
    if (!result.ok) return refusal(`could not save the todo: ${result.error}`)
    if (track === 'project') await this.ensureProject(pid, agent)
    this.invalidate()
    const flags = result.data.due === undefined ? '' : ` due=${result.data.due}`
    return { ok: true, message: `added ${result.data.track} todo ${result.data.id}${flags}`, item: result.data }
  }

  /**
   * Complete by id. The item is looked up FIRST, because "already done" and
   * "no such todo" are different answers and the store's update cannot tell
   * them apart (it rewrites whichever row matches).
   */
  async completeTodo(id: unknown, agent: unknown, pid?: string): Promise<TodoWriteResult> {
    if (typeof id !== 'string' || !isSafeKey(id)) return refusal('id must be a todo id from cortex_todo_list')
    const scope = await this.scopeFor(agent)
    const target = pid ?? scope.pid
    const known = await this.allTodos({ ...(target === undefined ? {} : { pid: target }), openOnly: false })
    const found = known.find(item => item.id === id)
    if (found === undefined) {
      return refusal(`no todo ${id} in life/work/daily${target === undefined ? '' : ` or project ${target.slice(0, 8)}…`} — pass its exact id, or the project id if it lives in another project`)
    }
    if (found.done === true) {
      return refusal(`todo ${id} is already completed${found.completedAt === undefined ? '' : ` at ${found.completedAt}`}`)
    }
    const result = await this.store.updateTodo(id, { done: true, ...(target === undefined ? {} : { pid: target }) })
    if (!result.ok) return refusal(`could not complete ${id}: ${result.error}`)
    if (result.data === null) return refusal(`todo ${id} disappeared before the update landed; try again`)
    this.invalidate()
    return { ok: true, message: `completed ${id}`, item: result.data }
  }

  async removeTodo(id: unknown, agent: unknown, pid?: string): Promise<TodoWriteResult> {
    if (typeof id !== 'string' || !isSafeKey(id)) return refusal('id must be a todo id from cortex_todo_list')
    const target = pid ?? (await this.scopeFor(agent)).pid
    const result = await this.store.removeTodo(id, target)
    if (!result.ok) return refusal(`could not remove ${id}: ${result.error}`)
    if (result.data !== true) return refusal(`no todo ${id} in life/work/daily${target === undefined ? '' : ` or project ${target.slice(0, 8)}…`}`)
    this.invalidate()
    return { ok: true, message: `removed ${id}` }
  }

  /** Record the project directory behind a project-scoped write (DESIGN §2). */
  async ensureProject(pid: string | undefined, agent: unknown): Promise<void> {
    if (pid === undefined) return
    const cwd = cwdOf(agent)
    const scope = this.scopes.peek(cwd)
    await this.store.ensureProject(pid, { ...(cwd === undefined ? {} : { cwd }), ...(scope?.remoteUrl === undefined ? {} : { remoteUrl: scope.remoteUrl }) })
  }

  // -------------------------------------------------------------- wiring ----
  /** True once the `cortex:todo` registration succeeded. */
  get hasContextSeam(): boolean {
    return this.seamInstalled
  }

  /**
   * Register the `cortex:todo` context. The host signature is a single object
   * (`context({ name, order, text })`) and a duplicate name throws, so this
   * runs once per mount and is fully guarded (P4).
   */
  install(): void {
    const ctx = this.deps.ctx
    try {
      const prompt = ctx.get('systemPrompt') as { context?: (value: { name: string; order: number; text: (context: unknown) => string }) => unknown } | undefined
      if (typeof prompt?.context !== 'function') {
        this.deps.warn('todo: systemPrompt.context unavailable — the todo digest will not be injected this session')
      } else {
        const disposer = prompt.context({ name: TODO_CONTEXT_NAME, order: TODO_CONTEXT_ORDER, text: this.contextText as never })
        this.seamInstalled = true
        if (typeof disposer === 'function') this.disposers.push(disposer as () => void)
      }
    } catch (error) {
      this.deps.warn(`todo: context registration refused: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      const stop = ctx.on('agent/created', ((payload: { agent?: HostAgent }) => {
        void this.warm(cwdOf(payload?.agent)).catch(() => {})
      }) as never)
      if (typeof stop === 'function') this.disposers.push(stop as () => void)
    } catch (error) {
      this.deps.warn(`todo: agent/created listener refused: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Undo listeners/registrations (module teardown; never throws). */
  dispose(): void {
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch {
        // A host-side disposer failure is not ours to propagate (P4).
      }
    }
    this.snapshots.clear()
    this.scopes.forget()
  }
}
