/**
 * Session → (project id, branch) resolution, memoised per cwd. ONE cache for
 * the whole plugin (M3).
 *
 * It used to be two, in two modules: this one in `memory/scope.ts` (which also
 * resolves the branch) and a pid-only twin in `todo/scope.ts` that todo, logs
 * and progress shared. Same key, same TTLs, same probes, separate maps — so the
 * same cwd was probed twice per window. In a live session it was worse than a
 * duplicate: the memory injector resolves the scope on every prompt assembly,
 * so the memory memo was warm while the task memo was still cold and todos and
 * project logs spawned `git` again for a cwd the plugin had just probed. That
 * is why the task modules now resolve through THIS cache.
 *
 * The per-turn cost of an injected block must stay a directory read, so the git
 * probes (repoRoot + origin + branch) are memoised per cwd for a short TTL
 * (C-36: "cost must be cached, not spawnSync per render"). `branch === null`
 * means UNKNOWN, never "no branch" (P8): unknown renders unscoped entries only.
 *
 * This file never touches `node:fs`/`node:child_process` directly: git probes
 * come from `src/lib/gitx.ts` and identity from `src/lib/pid.ts`.
 *
 * `modules/memory/scope.ts` and `modules/todo/scope.ts` re-export everything
 * here under their historical names, so no caller had to move.
 */
import { currentBranch, originRemote, repoRoot } from '../lib/gitx.ts'
import { projectId } from '../lib/pid.ts'

/** How long a resolved (pid, branch) pair may be reused. */
export const SCOPE_TTL_MS = 30_000

/** How many distinct cwds we memoise (one entry per live session; the rest is churn). */
export const SCOPE_CACHE_MAX = 32

/** A cwd that resolves to no git project at all still caches for this long. */
export const SCOPE_MISS_TTL_MS = 5_000

export interface SessionScope {
  /** cwd as the host reported it (undefined = no session context). */
  cwd?: string
  /** 16-hex project id, or undefined when there is no usable cwd. */
  pid?: string
  /** Active branch, or null when unknown (unknown → unscoped entries only). */
  branch: string | null
  /** True when a git repo root was found for this cwd. */
  inRepo: boolean
  /** Remote URL behind the pid (for honest "which project" reporting). */
  remoteUrl?: string
  /** Repo toplevel used to derive the pid (worktree/subdir normalisation). */
  root?: string
}

/** Injectable probe set, so a test can pin the cache without a git binary. */
export interface ScopeProbes {
  repoRoot(cwd: string): Promise<string | undefined>
  originRemote(cwd: string): Promise<string | undefined>
  currentBranch(cwd: string): Promise<string | undefined>
  projectId(input: { cwd: string; remoteUrl?: string }): Promise<string>
}

const liveProbes: ScopeProbes = { repoRoot, originRemote, currentBranch, projectId }

interface CacheRow {
  at: number
  scope: SessionScope
}

/**
 * A cache of scopes keyed by cwd. `resolve` is safe to call from the injection
 * callback: it never throws and it never re-probes inside the TTL window.
 */
export class ScopeCache {
  private readonly rows = new Map<string, CacheRow>()
  private readonly probes: ScopeProbes
  private readonly now: () => number
  private readonly ttl: number
  private readonly missTtl: number

  constructor(
    probes: Partial<ScopeProbes> = {},
    options: { now?: () => number; ttlMs?: number; missTtlMs?: number } = {},
  ) {
    this.probes = { ...liveProbes, ...probes }
    this.now = options.now ?? ((): number => Date.now())
    this.ttl = options.ttlMs ?? SCOPE_TTL_MS
    this.missTtl = options.missTtlMs ?? SCOPE_MISS_TTL_MS
  }

  /** Resolve (pid, branch) for one cwd; cached. A missing cwd yields an empty scope. */
  async resolve(cwd: string | undefined | null): Promise<SessionScope> {
    const key = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : ''
    if (key === '') return { branch: null, inRepo: false }
    const at = this.now()
    const hit = this.rows.get(key)
    if (hit !== undefined && at - hit.at <= (hit.scope.inRepo ? this.ttl : this.missTtl)) return hit.scope
    const scope = await this.probe(key)
    this.remember(key, { at, scope })
    return scope
  }

  /** Cached-only read for a synchronous render path. */
  peek(cwd: string | undefined | null): SessionScope | undefined {
    const key = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : ''
    if (key === '') return undefined
    const hit = this.rows.get(key)
    if (hit === undefined) return undefined
    return this.now() - hit.at <= (hit.scope.inRepo ? this.ttl : this.missTtl) ? hit.scope : undefined
  }

  /** Drop one memoised cwd (used after a project merge, or by tests). */
  forget(cwd?: string): void {
    if (cwd === undefined) this.rows.clear()
    else this.rows.delete(cwd.trim())
  }

  /** Number of live rows (test seam; never a behavioural input). */
  get size(): number {
    return this.rows.size
  }

  private remember(key: string, row: CacheRow): void {
    this.rows.set(key, row)
    while (this.rows.size > SCOPE_CACHE_MAX) {
      const oldest = this.rows.keys().next()
      if (oldest.done === true) break
      this.rows.delete(oldest.value)
    }
  }

  private async probe(cwd: string): Promise<SessionScope> {
    try {
      const [root, branch] = await Promise.all([this.probes.repoRoot(cwd), this.probes.currentBranch(cwd)])
      const where = typeof root === 'string' && root !== '' ? root : cwd
      const rawRemote = typeof root === 'string' && root !== '' ? await this.probes.originRemote(where) : undefined
      // An empty-string answer from git means "no remote", not "a remote called".
      const remote = typeof rawRemote === 'string' && rawRemote.trim() !== '' ? rawRemote.trim() : undefined
      const pid = await this.probes.projectId({ cwd: where, remoteUrl: remote })
      return {
        cwd,
        pid,
        branch: typeof branch === 'string' && branch !== '' ? branch : null,
        inRepo: typeof root === 'string' && root !== '',
        ...(remote !== undefined ? { remoteUrl: remote } : {}),
        root: where,
      }
    } catch {
      // A probe failure is a scoping loss, never a render failure: no project
      // entries this turn, and an unknown branch (unscoped only).
      return { branch: null, inRepo: false, ...(cwd === '' ? {} : { cwd }) }
    }
  }
}

/** The session cwd, read defensively from whatever the host handed us. */
export function cwdOf(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const session = (agent as { session?: unknown }).session
  if (session === null || typeof session !== 'object') return undefined
  const header = (session as { header?: unknown }).header
  if (header === null || typeof header !== 'object') return undefined
  const cwd = (header as { cwd?: unknown }).cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : undefined
}

/** The session id, same defensive walk (used for `source.sessionId`). */
export function sessionIdOf(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The process-wide scope memo. One instance, so the modules that resolve a cwd
 * agree on the answer and pay for the probes once (M3).
 */
let shared: ScopeCache | undefined

export function sharedScopeCache(): ScopeCache {
  if (shared === undefined) shared = new ScopeCache()
  return shared
}
