/**
 * M2 — the memory domain module.
 *
 * Owns: the `cortex:memory` injection block (DESIGN §3 caps, §9.1 G-04 header),
 * the seven `cortex_memory_*` agent tools (DESIGN §4), the memory-shaped RPC
 * endpoints of `.dev/RPC-ENDPOINTS.md`, and the pending-MEMORY approve/reject
 * decisions that belong to this domain.
 *
 * Does NOT own: the store (`src/host/store.ts`), the channels
 * (`src/host/rpc-channels.ts`), or the wiring (`src/host/index.ts`) — the parent
 * appends this module to `MODULES` and merges `readEndpoints` / `writeEndpoints`
 * into its dispatch tables. Nothing in this file registers a channel or a
 * settings namespace. A refused tool name fails THIS module only — the entry's
 * wiring loop reports it in `cortex_status` — so a memory failure costs memory,
 * never the boot (P4).
 */
import { neutralize } from '../../../lib/sanitize.ts'
import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import type { ScopeCache } from './scope.ts'
import type { ConfirmTokens as ConfirmTokensType } from './ops.ts'
import { createMemoryInjector, bindInjector, registerOnce } from './runtime.ts'
import { buildTools } from './tools.ts'

export { readEndpoints, writeEndpoints, READ_ENDPOINT_NAMES, WRITE_ENDPOINT_NAMES } from './endpoints.ts'
export type { MemoryEndpoint } from './endpoints.ts'
export { assembleBlock, capBlock, loadTracks, memoryHeader, renderMemoryBlock, INJECT_FOOTER, STORE_LIST_CAP } from './render.ts'
export type { AssembleInput, AssembleResult, TrackLoad } from './render.ts'
export { searchEntries, renderHits, tokenize, scoreEntry, snippet } from './search.ts'
export type { SearchHit } from './search.ts'
export { ScopeCache, SCOPE_TTL_MS, cwdOf, sessionIdOf } from './scope.ts'
export { createMemoryInjector, memoryContext, registerOnce, scopeCache, confirmTokens } from './runtime.ts'
export { ConfirmTokens } from './ops.ts'

/** Module id used by the wiring loop and reported by `cortex_status`. */
export const name = 'memory'

/** The single registration name of the injection seam (a duplicate throws). */
export const MEMORY_CONTEXT = 'cortex:memory'

/** DESIGN §3 render order: memory leads the plugin blocks, todo/prompt follow. */
export const MEMORY_CONTEXT_ORDER = 40

/** Tool ids owned by this module (reported through `cortex_status`). */
export const TOOLS = [
  'cortex_memory_remember',
  'cortex_memory_search',
  'cortex_memory_list',
  'cortex_memory_archive',
  'cortex_memory_restore',
  'cortex_memory_delete',
  'cortex_memory_update',
] as const

/**
 * Wire the module. Called once per host context by the entry's module loop;
 * tool registration is guarded, the injection seam is registered at most once,
 * and a refused duplicate is reported through the runtime view instead of
 * taking anything else down.
 */
export function apply(
  deps: ModuleDeps,
  options: { scopes?: ScopeCache; tokens?: ConfirmTokensType } = {},
): void {
  const { ctx, cfg, store, runtime } = deps
  // P9: a log line can name user data (a path, a refusal), and the host log is
  // read by people and by models alike — neutralize at the edge, not at the sink.
  const log = (message: string): void => deps.log(neutralize(message))
  const warn = (message: string): void => deps.warn(neutralize(message))
  const injector = createMemoryInjector(deps, { ...(options.scopes ? { scopes: options.scopes } : {}), ...(options.tokens ? { tokens: options.tokens } : {}) })
  bindInjector(ctx, injector)

  const injected = registerOnce(deps, injector, MEMORY_CONTEXT, MEMORY_CONTEXT_ORDER)
  if (injected === 'unavailable') warn('no systemPrompt.context seam in this profile; memory injection is off, tools and RPC still work')

  const refused: string[] = []
  for (const definition of buildTools(deps, injector)) {
    const result = registerToolSafe(ctx, definition)
    if (!result.ok) refused.push(`${result.name}: ${result.error ?? 'refused'}`)
  }
  log(`memory module wired (tools=${TOOLS.length}, context=${injected}, autoAccept=${cfg().memory.autoAccept}, root=${store.root})`)
  if (refused.length > 0) {
    // A collision is a wiring bug the integrator must see; report it in the
    // runtime view (which `cortex_status` prints) and fail only this module.
    try {
      runtime().errors?.push(neutralize(`module:memory ${refused.join('; ')}`))
    } catch {
      // The view is diagnostics only; losing it must not change the outcome.
    }
    throw new Error(`memory tool registration refused: ${refused.join('; ')}`)
  }
}
