/**
 * M-decisions: decision module face.
 *
 * Parses [decision] tagged lines from logs into structured JSON records,
 * exposes a search/list/link surface to both the model (tools) and the panel
 * (RPC endpoints), and links decisions to the memory entries they came from.
 */
import { registerLifecycle, registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { DecisionService, decisionService } from './service.ts'
import { decisionTools } from './tools.ts'
import { bindDecisionEndpoints } from './rpc.ts'

export const name = 'decisions'

/** Tool ids this module owns. */
export const TOOLS = [
  'cortex_decision_index_logs',
  'cortex_decision_search',
  'cortex_decision_list',
  'cortex_decision_link',
] as const

export { bindDecisionEndpoints, readEndpoints, writeEndpoints, decisionEndpoints } from './rpc.ts'
export { DecisionService, decisionService } from './service.ts'
export { parseDecisionLine } from './parser.ts'
export { renderDecision, renderDecisionList, decisionListHeader, LINK_LIMIT, LINK_MAX } from './service.ts'
export type { Decision, DecisionParseResult } from './types.ts'
export type { DecisionSearchHit, DecisionSearchResult, DecisionListResult, IndexResult } from './service.ts'

let svc: DecisionService | null = null
export function getDecisionService(): DecisionService | null { return svc }

export function apply(deps: ModuleDeps): void {
  svc = decisionService(deps)
  // The RPC maps close over the service, so they only answer once the registry
  // points at THIS instance. Without this the four tools work and every
  // `decisions.*` call refuses with "not-wired" — the same two-path split the
  // board module had to close.
  bindDecisionEndpoints(svc)

  registerLifecycle(deps.ctx, () => { svc = null }, 'dsh-cortex:decisions service', deps.warn)

  let registered = 0
  for (const def of decisionTools(svc)) {
    const result = registerToolSafe(deps.ctx, def)
    if (result.ok) registered += 1
    else deps.warn(`decisions: registration refused for ${result.name} (${result.error ?? 'unknown'})`)
  }

  deps.log(`decisions: ready (tools=${String(registered)}/${String(TOOLS.length)})`)
}
