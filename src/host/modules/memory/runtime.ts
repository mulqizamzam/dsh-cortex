/**
 * Per-turn injection plumbing for the memory module.
 *
 * The seam is `systemPrompt.context(name, { order, text })` (docs/HOST-API.md
 * §3): the callback runs once per prompt assembly and must return a STRING —
 * the host has no await here, and a memory render is async (it reads git and the
 * state tree). So the render happens one step ahead of the turn: `text()`
 * returns the memoised block for this session's cwd and schedules the next one.
 *
 * Rules this file exists to keep:
 * - never throw, never block, never call git more than once per TTL (C-36);
 * - one registration per host context (a duplicate `context()` name THROWS);
 * - the block is neutralized inside the renderer; this layer adds no text.
 */
import { errorMessage } from '../../../lib/errors.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { ModuleDeps } from '../../types.ts'
import { renderMemoryBlock } from './render.ts'
import type { AssembleResult } from './render.ts'
import { ScopeCache, cwdOf } from './scope.ts'
import { ConfirmTokens } from './ops.ts'
import type { MemoryContext } from './ops.ts'

/** How fresh a memoised block must be to be handed to the renderer. */
export const RENDER_TTL_MS = 5_000

/** A memoised block older than this is withheld rather than served stale. */
export const RENDER_MAX_AGE_MS = 30_000

/** Rows kept per cwd: sessions are few, and churn should not grow the map. */
export const RENDER_CACHE_MAX = 16

/** Shared scope memo: the tools, the RPC endpoints and the injection agree on
 * one project/branch answer instead of each probing git. */
export const scopeCache = new ScopeCache()

/** Shared two-step confirmation tokens (delete). In-memory by design. */
export const confirmTokens = new ConfirmTokens()

/**
 * The injector each `apply()` built, keyed by host context. The RPC endpoints
 * mutate memory too, and a render cached before that write would hide it for up
 * to a TTL — so they look the injector up here and invalidate it.
 */
const injectors = new WeakMap<object, MemoryInjector>()

export function bindInjector(ctx: object, injector: MemoryInjector): void {
  injectors.set(ctx, injector)
}

/** The injector `apply()` bound for this context, or a private default. */
export function injectorFor(deps: ModuleDeps): MemoryInjector {
  const bound = injectors.get(deps.ctx)
  if (bound !== undefined) return bound
  const created = createMemoryInjector(deps)
  injectors.set(deps.ctx, created)
  return created
}

/** The context the RPC handlers operate in: same caches as the tool surface. */
export function contextFor(deps: ModuleDeps): MemoryContext {
  const injector = injectorFor(deps)
  return memoryContext(deps, injector.scopes, injector.tokens)
}

/** Drop every memoised block for one host context (call after any memory write). */
export function invalidateInjector(ctx: unknown): void {
  if (typeof ctx !== 'object' || ctx === null) return
  try {
    injectors.get(ctx)?.invalidate()
  } catch {
    // A lost cache is never an error worth surfacing.
  }
}

/** The operation context for one module call, from the wiring deps. */
export function memoryContext(deps: ModuleDeps, scopes: ScopeCache = scopeCache, tokens: ConfirmTokens = confirmTokens): MemoryContext {
  return {
    config: deps.cfg(),
    store: deps.store,
    scopes,
    tokens,
    sessionCwd: (sessionId: string): string | undefined => {
      try {
        return cwdOf(deps.ctx.agents?.get?.(sessionId))
      } catch {
        return undefined
      }
    },
  }
}

export interface MemoryInjector {
  /** The `systemPrompt.context` callback body: sync, string, never throws. */
  text(context: unknown): string
  /** Force one async render (tests, and the first call of a session). */
  refresh(cwd?: string): Promise<AssembleResult>
  /** Forget memoised blocks (after a write, or on config change). */
  invalidate(): void
  /** Memoised rows, for assertions and diagnostics only. */
  readonly cached: number
  /** The scope memo this injector probes through (tools share it, C-36). */
  readonly scopes: ScopeCache
  /** Single-use tokens for the two-step delete (per instance, in-memory). */
  readonly tokens: ConfirmTokens
}

/**
 * Build the per-context injector. `now` is injectable so a test can pin the
 * cache age instead of sleeping.
 */
export function createMemoryInjector(
  deps: ModuleDeps,
  options: { now?: () => number; ttlMs?: number; maxAgeMs?: number; scopes?: ScopeCache; tokens?: ConfirmTokens } = {},
): MemoryInjector {
  const clock = options.now ?? ((): number => Date.now())
  const ttl = options.ttlMs ?? RENDER_TTL_MS
  const maxAge = options.maxAgeMs ?? RENDER_MAX_AGE_MS
  const scopes = options.scopes ?? scopeCache
  const tokens = options.tokens ?? confirmTokens
  const rows = new Map<string, { at: number; result: AssembleResult }>()
  const running = new Set<string>()

  const rowFor = (cwd: string | undefined): { at: number; result: AssembleResult } | undefined =>
    rows.get(cwd ?? '(no session cwd)')

  const render = async (cwd: string | undefined): Promise<AssembleResult> => {
    const empty: AssembleResult = { block: '', included: 0, omitted: 0, truncated: false, bytes: 0 }
    try {
      const config = deps.cfg()
      if (config.inject.enabled !== true) {
        rows.set(cwd ?? '(no session cwd)', { at: clock(), result: empty })
        return empty
      }
      const scope = await scopes.resolve(cwd)
      const result = await renderMemoryBlock(config, deps.store, { ...(scope.pid ? { pid: scope.pid } : {}), branch: scope.branch })
      rows.set(cwd ?? '(no session cwd)', { at: clock(), result })
      if (rows.size > RENDER_CACHE_MAX) {
        const oldest = rows.keys().next()
        if (oldest.done !== true) rows.delete(oldest.value)
      }
      return result
    } catch (error) {
      // A render that cannot complete must withhold memory, never crash the host.
      deps.warn(`memory render failed: ${errorMessage(error)}`)
      rows.set(cwd ?? '(no session cwd)', { at: clock(), result: empty })
      return empty
    } finally {
      running.delete(cwd ?? '(no session cwd)')
    }
  }

  return {
    text(context: unknown): string {
      try {
        const config = deps.cfg()
        if (config.inject.enabled !== true) return ''
        const cwd = cwdOf((context as { agent?: unknown } | undefined)?.agent)
        const row = rowFor(cwd)
        const at = clock()
        if (row !== undefined && at - row.at < ttl) return row.result.block
        if (!running.has(cwd ?? '(no session cwd)')) {
          running.add(cwd ?? '(no session cwd)')
          void render(cwd)
        }
        if (row === undefined || at - row.at > maxAge) return ''
        return row.result.block
      } catch (error) {
        deps.warn(`memory injection callback failed: ${errorMessage(error)}`)
        return ''
      }
    },
    refresh: (cwd?: string) => render(cwd),
    invalidate(): void {
      rows.clear()
    },
    get cached(): number {
      return rows.size
    },
    get scopes(): ScopeCache {
      return scopes
    },
    get tokens(): ConfirmTokens {
      return tokens
    },
  }
}

/** The `systemPrompt` service surface we use, narrowed from the untyped host.
 * PARENT FIX (integrasi): real host signature is ONE object —
 * `context(entry: PromptContext)` (host packages/core/system-prompt/src/index.ts:398;
 * non-finite order THROWS TypeError at registration). The earlier 2-arg call was
 * swallowed by the catch below as 'refused' on the real host — tests stayed green
 * only because the fake mirrored the wrong shape; memory would silently never
 * inject in production. Fixture now enforces the host signature. */
export interface SystemPromptContextApi {
  context(entry: { name: string; order: number; text: string | ((context: unknown) => string) }): unknown
}

/** Contexts that already carry a memory block; a second `context()` name throws. */
const registeredContexts = new WeakSet<object>()

/**
 * Register the memory block exactly once per host context (C-16): a repeat
 * `apply()` reuses the first registration instead of paying the host's duplicate
 * name throw, and a host with no `systemPrompt.context` seam simply goes without
 * the block — the tools and the endpoints are unaffected.
 */
export type RegisterOutcome = 'registered' | 'already' | 'unavailable' | 'refused'

export function registerOnce(
  deps: ModuleDeps,
  injector: MemoryInjector,
  name: string,
  order: number,
): RegisterOutcome {
  const ctx = deps.ctx
  if (registeredContexts.has(ctx)) return 'already'
  try {
    const service = ctx.get('systemPrompt') as SystemPromptContextApi | undefined
    if (service === undefined || service === null || typeof service.context !== 'function') return 'unavailable'
    service.context({ name, order, text: (context: unknown) => injector.text(context) })
    registeredContexts.add(ctx)
    return 'registered'
  } catch (error) {
    // The host refused (or the seam is broken): memory stays off for this
    // profile, the tools and endpoints keep working, and nothing escapes (P4).
    registeredContexts.add(ctx)
    deps.warn(`memory context registration failed: ${neutralize(errorMessage(error))}`)
    return 'refused'
  }
}
