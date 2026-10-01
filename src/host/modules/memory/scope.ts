/**
 * The memory module's scope seam, kept as an import path. The cache itself
 * moved one level up to `src/host/scope.ts` (M3): todo, logs and progress
 * resolve the same cwd, and two memos of one cwd meant two sets of git probes
 * for the same answer. Everything below is the same object.
 */
export {
  ScopeCache,
  cwdOf,
  sessionIdOf,
  sharedScopeCache,
  SCOPE_TTL_MS,
  SCOPE_MISS_TTL_MS,
  SCOPE_CACHE_MAX,
} from '../../scope.ts'
export type { SessionScope, ScopeProbes } from '../../scope.ts'
