import { neutralize } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import { refuse } from '../../rpc-error.ts'
import type { EndpointHandler } from './service.ts'
import { delegateEndpoints } from './service.ts'
import type { DelegateService } from './service.ts'

/**
 * RPC endpoint face for the delegate module. The parent owns the channel
 * mount (`.dev/RPC-ENDPOINTS.md`: one dispatch per channel, module endpoints
 * appended there), so this module exports handler maps and never registers a
 * channel itself. Maps are module-level singletons so the parent can import
 * them at top level; `bindEndpoints` points them at the live service. Before
 * binding (or after a failed boot) every call answers honestly instead of
 * throwing.
 */

const notWired = (): RpcResult<unknown> => ({
  ok: false,
  error: { code: 'internal', message: '[not-wired] delegation endpoints are not wired (module failed to start?)' },
})

const registry: { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } = { read: {}, write: {} }

export function bindEndpoints(svc: DelegateService): void {
  const next = delegateEndpoints(svc)
  registry.read = next.read
  registry.write = next.write
}

function routed(kind: 'read' | 'write', endpoint: string): EndpointHandler {
  return async (payload: unknown): Promise<RpcResult<unknown>> => {
    const handler = registry[kind][endpoint]
    if (handler === undefined) return notWired()
    try {
      return await handler(payload)
    } catch (error) {
      // Endpoint handlers must never leak a throw to the transport — and the
      // failure text is client-visible, so it is neutralized too (P9).
      const detail = error instanceof Error ? error.message : String(error)
      return refuse(neutralize(detail), 'handler-failed')
    }
  }
}

/** Endpoint names the delegate module answers on `/dsh-cortex-read`. */
export const readEndpoints: Record<string, EndpointHandler> = {
  'jobs.list': routed('read', 'jobs.list'),
  'jobs.get': routed('read', 'jobs.get'),
  'jobs.logs': routed('read', 'jobs.logs'),
  'jobs.result': routed('read', 'jobs.result'),
}

/** Endpoint names the delegate module answers on `/dsh-cortex-write`. */
export const writeEndpoints: Record<string, EndpointHandler> = {
  'jobs.cancel': routed('write', 'jobs.cancel'),
  'jobs.retry': routed('write', 'jobs.retry'),
}
