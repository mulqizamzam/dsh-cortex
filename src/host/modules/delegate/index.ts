/**
 * M6 delegate module face (DISPATCH integration rule): exports
 * `{ name, TOOLS, apply, readEndpoints, writeEndpoints }`. The parent appends
 * this to `MODULES` in `src/host/index.ts` and routes the endpoint maps into
 * the two RPC channels at mount; nothing here touches shared files.
 *
 * TODO for the parent (not trivial, deliberately not faked):
 * `cortex_agent_delegate`, the in-host variant that runs a task through the
 * host `subagents` service (HOST-API §7: `start(name, {...}) -> {id, result,
 * dispose}` instead of spawning a CLI). It needs a provider-name registry
 * distinct from `delegation.runners`, its own write-back loop over a Promise
 * (no exit codes, no streams), and `ctx.get('subagents')` is not in the typed
 * host model — wiring it blind would be a lie, so the CLI path stands alone
 * in M6 v1.
 */
import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { DelegateService } from './service.ts'
import { delegateTools } from './tools.ts'
import { bindEndpoints } from './rpc.ts'

export const name = 'delegate'
export const TOOLS = [
  'cortex_delegate',
  'cortex_delegate_status',
  'cortex_delegate_logs',
  'cortex_delegate_result',
  'cortex_delegate_cancel',
  'cortex_delegate_retry',
] as const

export { readEndpoints, writeEndpoints } from './rpc.ts'
export { DelegateService } from './service.ts'

let service: DelegateService | null = null

/** The live service after `apply` (status tooling, tests, integration). */
export function getDelegateService(): DelegateService | null {
  return service
}

export function apply(deps: ModuleDeps): void {
  const svc = new DelegateService(deps)
  service = svc
  bindEndpoints(svc)

  // Restart-safe orphan recovery (BRIEFS M6): mark pre-existing live jobs
  // 'lost' BEFORE anything can dispatch, and say so in the log — never
  // silently, never by re-spawning.
  void svc.sweepOrphans().catch((error: unknown) => {
    deps.warn(`delegate: orphan sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  let coreFailed: string | undefined
  for (const definition of delegateTools(svc)) {
    const registered = registerToolSafe(deps.ctx, definition)
    if (!registered.ok) {
      const detail = `cortex tool registration refused: ${registered.name} (${registered.error ?? 'unknown'})`
      if (definition.name === 'cortex_delegate') coreFailed = detail
      deps.warn(detail)
    }
  }
  // A module without its dispatch tool is not worth half-registering.
  if (coreFailed !== undefined) throw new Error(coreFailed)

  const runners = Object.keys(deps.cfg().delegation.runners).length
  deps.log(`delegate: ready (enabled=${String(deps.cfg().delegation.enabled)}, runners=${String(runners)})`)
}
