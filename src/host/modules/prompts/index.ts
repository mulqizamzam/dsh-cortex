/**
 * M4 · the prompts module face (DISPATCH integration rule): exports
 * `{ name, TOOLS, apply, readEndpoints, writeEndpoints }`.
 *
 * What this module owns:
 *  - the five `cortex_prompt_*` tools (DESIGN §4) — list, get, save (proposal
 *    only), toggle, inject;
 *  - the `cortex:prompts` per-turn injection seam at order 43, which renders the
 *    caller's own queue with the DESIGN §9.1 G-03 header, spends rounds only on a
 *    render that actually happened, and ends a sticky row with one honest expiry
 *    line after {@link STICKY_MAX_TURNS};
 *  - the prompt-shaped RPC endpoints of `.dev/RPC-ENDPOINTS.md`
 *    (`prompts.list` / `prompts.get` / `prompts.save` / `prompts.toggle` /
 *    `prompts.delete` / `inject.now`), where `prompts.save` is the human path
 *    that writes the library directly;
 *  - the inject queue file inside the store's own `inject/<sessionId>.json`.
 *
 * What it deliberately does NOT do:
 *  - it never registers an RPC channel, a settings namespace or a second context
 *    name (a duplicate `context()` name throws in the host);
 *  - it never lets a model write the library: `cortex_prompt_save` files a
 *    proposal, and approval is a human click (see `pending.ts`);
 *  - it never injects across sessions in v1 — see `resolveAgentInjectTarget`;
 *  - it never throws out of `apply()` unless the module is genuinely useless
 *    (P4): a refused seam is logged and the tools/RPC half still work.
 */
import { registerLifecycle, registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { promptsService, resetPromptsService } from './service.ts'
import type { PromptsService } from './service.ts'
import { promptTools } from './tools.ts'
import { bindPromptEndpoints } from './rpc.ts'
import type { EndpointHandler, PromptSummary } from './rpc.ts'
import { STICKY_MAX_TURNS } from './queue.ts'

export const name = 'prompts'

/** Tool ids this module owns (reported by `cortex_status` through the wiring loop). */
export const TOOLS = [
  'cortex_prompt_list',
  'cortex_prompt_get',
  'cortex_prompt_save',
  'cortex_prompt_toggle',
  'cortex_prompt_inject',
] as const

export { INJECT_SCOPE_REFUSAL, LIMITS, PROMPTS_CONTEXT_NAME, PROMPTS_CONTEXT_ORDER, PromptsService, promptsService, resetPromptsService, resolveAgentInjectTarget, sessionIdOf } from './service.ts'
export { MANUAL_TEXT_CHARS, MANUAL_TITLE, ONCE_TURNS, PROMPTS_BLOCK_CHARS, PROMPT_BODY_CHARS, PROMPT_TITLE_CHARS, QUEUE_MAX_ROWS, STICKY_MAX_TURNS, advanceRows, clampBody, normalizeRows, owesExpiry, safeSessionKey, seedRounds } from './queue.ts'
export type { PromptQueue, PromptRow } from './queue.ts'
export { entryBlock, expiryHeader, renderPromptBlock, workflowHeader } from './render.ts'
export type { RenderInput, RenderOutput } from './render.ts'
export { READ_ENDPOINT_NAMES, UI_BODY_CHARS, WRITE_ENDPOINT_NAMES, bindPromptEndpoints, promptEndpoints, readEndpoints, writeEndpoints } from './rpc.ts'
export type { EndpointHandler, PromptSummary }
export { approvePendingPrompt, proposalToPrompt } from './pending.ts'
export type { PendingPromptDecision } from './pending.ts'

/** Tool names THIS module registered on each host context (a re-mount is a no-op). */
const mountedTools = new WeakMap<object, Set<string>>()

let service: PromptsService | null = null

/** The live service after `apply` (tests, status reporting, integration). */
export function getPromptsService(): PromptsService | null {
  return service
}

/** Undo the mounted seam/queue (hot-reload hygiene; sibling modules do this too). */
export function disposePrompts(): void {
  if (service === null) return
  resetPromptsService(service.store.root)
  service.dispose()
  service = null
}

export function apply(deps: ModuleDeps): void {
  // One service per state root: the tools, the endpoints and the seam must all
  // see the same in-memory queue, or a round spent by the seam would be
  // invisible to the panel.
  const svc = promptsService(deps)
  service = svc
  // F10: `disposePrompts` existed but nothing called it, so the root-keyed cache
  // above kept handing a superseded instance (queue, primed marks, captured deps)
  // to the next boot. The host's own ownership now runs it. Identity-guarded: a
  // late release must not dispose the live instance.
  registerLifecycle(deps.ctx, () => { if (service === svc) disposePrompts() }, 'dsh-cortex:prompts service', deps.warn)
  // The seam first: a refused tool must not cost the session its injections,
  // and a refused seam must not cost the caller the tools (P4 keeps them apart).
  svc.install()
  bindPromptEndpoints(svc)
  // Warm the queues of whoever is live NOW, so an injection queued before a
  // restart renders on this session's first assembly instead of its second.
  // Fire-and-forget: a boot must not wait on the state tree (P4).
  void svc.warmLiveSessions()

  // A repeat `apply()` on the SAME host context (hot reload, a second wiring
  // pass) owns these names already: re-registering would only produce five
  // collision warnings and make a healthy module look broken.
  const owned = mountedTools.get(deps.ctx)
  let refused = 0
  const failures: string[] = []
  if (owned !== undefined && TOOLS.every(name => owned.has(name))) {
    deps.log('prompts: already mounted on this context (tools and seam reused)')
  } else {
    const mine = owned ?? new Set<string>()
    mountedTools.set(deps.ctx, mine)
    for (const definition of promptTools(svc)) {
      const registered = registerToolSafe(deps.ctx, definition)
      if (registered.ok) mine.add(registered.name)
      else {
        refused += 1
        failures.push(`${registered.name}: ${registered.error ?? 'unknown'}`)
        deps.warn(`prompts: registration refused: ${failures[failures.length - 1]}`)
      }
    }
  }
  // A module with neither its tools nor its injection seam is broken, not
  // degraded: say so, so `cortex_status` reports failed instead of ok.
  if (refused === TOOLS.length && !svc.hasContextSeam) {
    throw new Error(`prompts: no tool registered and no context seam (${failures.join('; ')})`)
  }
  deps.log(`prompts: ready (enabled=${String(svc.enabled)}, seam=${String(svc.hasContextSeam)}, tools=${String(TOOLS.length - refused)}/${String(TOOLS.length)}, stickyMaxTurns=${String(STICKY_MAX_TURNS)}, root=${deps.store.root})`)
}
