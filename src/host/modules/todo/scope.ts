/**
 * Session → project resolution for the tasks domain (M3).
 *
 * The cache itself is the plugin-wide one in `src/host/scope.ts`; todo, logs and
 * progress all resolve through it, so a cwd the memory injector already probed
 * costs these modules nothing. What stays here is the task-domain vocabulary:
 * the pid-only names they were written against (`TaskScope`, `TaskScopeCache`,
 * the TASK_SCOPE_* limits) and the two helpers only these modules use.
 *
 * `TaskScope` is now the richer `SessionScope`: a strict superset, so a caller
 * that only reads `pid` / `cwd` / `inRepo` / `remoteUrl` cannot tell, except
 * that resolving a cwd also tells us its branch — which used to cost one more
 * `git` spawn per cold resolve and now costs nothing, because the branch probe
 * runs in the same `Promise.all` as the repo-root probe it always accompanied.
 *
 * Same rule as everywhere else: identity comes from `src/lib/pid.ts` (remote
 * wins over cwd) and the git probes come from `src/lib/gitx.ts`; nothing in
 * here touches `node:fs`/`node:child_process`.
 */
import { isSafeKey } from '../../../lib/ids.ts'
import { SCOPE_CACHE_MAX, SCOPE_MISS_TTL_MS, SCOPE_TTL_MS, ScopeCache, sharedScopeCache } from '../../scope.ts'
import type { SessionScope } from '../../scope.ts'

export { cwdOf, sessionIdOf } from '../../scope.ts'
export type { ScopeProbes } from '../../scope.ts'

/** The resolved scope, under the name these modules always used. */
export type TaskScope = SessionScope

/** The plugin-wide cache, under the name these modules always used. */
export const TaskScopeCache = ScopeCache
export type TaskScopeCache = ScopeCache

/** How long a resolved pid may be reused for a cwd that is a repo. */
export const TASK_SCOPE_TTL_MS = SCOPE_TTL_MS
/** A cwd that is not a repo is re-probed sooner (a `git init` should be noticed). */
export const TASK_SCOPE_MISS_TTL_MS = SCOPE_MISS_TTL_MS
/** Ceiling on memoised cwds (one per live session; the rest is churn). */
export const TASK_SCOPE_MAX = SCOPE_CACHE_MAX

/** The cache key a digest render is scoped to: the pid, or 'global'. */
export function scopeKeyOf(pid: string | undefined): string {
  return pid === undefined || pid === '' ? 'global' : pid
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

/** The shared scope memo, now the same one the memory injector warms. */
export function sharedTaskScopes(): TaskScopeCache {
  return sharedScopeCache()
}
