/**
 * Session → project resolution for the tasks domain (M3).
 *
 * Deliberately smaller than the memory module's scope cache: todos and project
 * logs do not care about the branch (DESIGN §2 — only entries carry `branches`),
 * so this resolves `pid` only. Same rule as everywhere else: identity comes from
 * `src/lib/pid.ts` (remote wins over cwd) and the git probes come from
 * `src/lib/gitx.ts`; nothing in here touches `node:fs`/`node:child_process`.
 *
 * The injection seam (`systemPrompt.context`) is evaluated SYNCHRONOUSLY per
 * assembly, so every lookup used on that path must already be memoised. `peek`
 * is the sync read; `resolve` is the async warm-up.
 */
import { originRemote, repoRoot } from '../../../lib/gitx.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { projectId } from '../../../lib/pid.ts'

/** A resolved project scope: the cwd plus its 16-hex project id. */
export interface TaskScope {
  cwd?: string
  pid?: string
  inRepo: boolean
  remoteUrl?: string
}

/** Probes are injectable so tests never need a git binary or a real repo. */
export interface ScopeProbes {
  repoRoot(cwd: string): Promise<string | undefined>
  originRemote(cwd: string): Promise<string | undefined>
  projectId(input: { cwd: string; remoteUrl?: string }): Promise<string>
}

const liveProbes: ScopeProbes = { repoRoot, originRemote, projectId }

/** How long a resolved pid may be reused for a cwd that is a repo. */
export const TASK_SCOPE_TTL_MS = 30_000
/** A cwd that is not a repo is re-probed sooner (a `git init` should be noticed). */
export const TASK_SCOPE_MISS_TTL_MS = 5_000
/** Ceiling on memoised cwds (one per live session; the rest is churn). */
export const TASK_SCOPE_MAX = 32

/** The cache key a digest render is scoped to: the pid, or 'global'. */
export function scopeKeyOf(pid: string | undefined): string {
  return pid === undefined || pid === '' ? 'global' : pid
}

/**
 * Memoised cwd → pid. Never throws: a failed probe is a lost project scope,
 * not a failed turn (P4), and renders as the global scope.
 */
export class TaskScopeCache {
  private readonly rows = new Map<string, { at: number; scope: TaskScope }>()
  private readonly probes: ScopeProbes
  private readonly now: () => number

  constructor(probes: Partial<ScopeProbes> = {}, options: { now?: () => number } = {}) {
    this.probes = { ...liveProbes, ...probes }
    this.now = options.now ?? ((): number => Date.now())
  }

  /** Resolve the scope for one cwd, probing at most once per TTL window. */
  async resolve(cwd: string | undefined | null): Promise<TaskScope> {
    const key = normalise(cwd)
    if (key === '') return { inRepo: false }
    const hit = this.rows.get(key)
    if (hit !== undefined && this.stillFresh(hit.at, hit.scope)) return hit.scope
    const scope = await this.probe(key)
    this.remember(key, scope)
    return scope
  }

  /** Sync read for the injection path; undefined when nothing is memoised. */
  peek(cwd: string | undefined | null): TaskScope | undefined {
    const key = normalise(cwd)
    if (key === '') return undefined
    const hit = this.rows.get(key)
    if (hit === undefined) return undefined
    return this.stillFresh(hit.at, hit.scope) ? hit.scope : undefined
  }

  /** Drop one memoised cwd, or all of them. */
  forget(cwd?: string): void {
    if (cwd === undefined) this.rows.clear()
    else this.rows.delete(normalise(cwd))
  }

  /** Number of live rows (test seam, never a behavioural input). */
  get size(): number {
    return this.rows.size
  }

  private stillFresh(at: number, scope: TaskScope): boolean {
    return this.now() - at <= (scope.inRepo ? TASK_SCOPE_TTL_MS : TASK_SCOPE_MISS_TTL_MS)
  }

  private remember(key: string, scope: TaskScope): void {
    this.rows.set(key, { at: this.now(), scope })
    while (this.rows.size > TASK_SCOPE_MAX) {
      const oldest = this.rows.keys().next()
      if (oldest.done === true) break
      this.rows.delete(oldest.value)
    }
  }

  private async probe(cwd: string): Promise<TaskScope> {
    try {
      const root = await this.probes.repoRoot(cwd)
      const where = typeof root === 'string' && root !== '' ? root : cwd
      const remote = typeof root === 'string' && root !== '' ? await this.probes.originRemote(where) : undefined
      const pid = await this.probes.projectId({ cwd: where, ...(remote === undefined ? {} : { remoteUrl: remote }) })
      return {
        cwd,
        pid,
        inRepo: typeof root === 'string' && root !== '',
        ...(remote === undefined ? {} : { remoteUrl: remote }),
      }
    } catch {
      return { inRepo: false, cwd }
    }
  }
}

function normalise(cwd: string | undefined | null): string {
  return typeof cwd === 'string' ? cwd.trim() : ''
}

/**
 * A project id arriving from a tool argument or an RPC payload must be the
 * 16-hex-ish key the store itself would have derived — anything else (a path,
 * a `../`, an empty string) is refused at this boundary, because the store
 * joins it straight into a filename (P5: nothing may write outside the root).
 */
export function safePid(value: unknown): string | undefined {
  return typeof value === 'string' && isSafeKey(value) ? value : undefined
}

/**
 * The process-wide scope cache. The three M3 modules each need the same
 * cwd→pid answer; one memo means one git probe per cwd per TTL window instead
 * of three. Tests build their own `TaskScopeCache` with fake probes.
 */
let shared: TaskScopeCache | undefined

export function sharedTaskScopes(): TaskScopeCache {
  if (shared === undefined) shared = new TaskScopeCache()
  return shared
}

/** Defensive read of `agent.session.header.cwd` (the host shape is `unknown`). */
export function cwdOf(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const session = (agent as { session?: unknown }).session
  if (session === null || typeof session !== 'object') return undefined
  const header = (session as { header?: unknown }).header
  if (header === null || typeof header !== 'object') return undefined
  const cwd = (header as { cwd?: unknown }).cwd
  const value = typeof cwd === 'string' ? cwd.trim() : ''
  return value === '' ? undefined : value
}

/** Defensive read of `agent.id` — the session key the nudge tracker counts on. */
export function sessionIdOf(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}
