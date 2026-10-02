/**
 * Decision RPC endpoints. Follows the board/rpc.ts pattern: module-level
 * registry bound to a live service; handlers answer honestly before binding;
 * never throws to the transport.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import type { DecisionService } from './service.ts'
import { refuse } from '../../rpc-error.ts'

export type EndpointHandler = (payload: unknown) => Promise<RpcResult<unknown>> | RpcResult<unknown>

const asNope = (message: string, code = 'refused'): RpcResult<unknown> =>
  refuse(neutralize(clampText(message, 400)), code)

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

const registry: { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } = { read: {}, write: {} }

/** Handlers for the decision module against one live service. */
export function decisionEndpoints(svc: DecisionService): { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } {
  const read: Record<string, EndpointHandler> = {
    'decisions.list': async (payload) => {
      const raw = payloadOf(payload)
      const pid = stringOf(raw.pid) || undefined
      const limit = numOf(raw.limit)
      const result = await svc.list({ pid, limit })
      if (result.decisions.length === 0 && result.total === 0 && result.text.startsWith('could not')) {
        return asNope(result.text, 'refused')
      }
      return {
        ok: true,
        value: neutralizeDeep({
          decisions: result.decisions,
          total: result.total,
          text: result.text,
        }),
      }
    },
    'decisions.search': async (payload) => {
      const raw = payloadOf(payload)
      const query = stringOf(raw.query)
      const pid = stringOf(raw.pid) || undefined
      const tags = Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string') as string[] : undefined
      const limit = numOf(raw.limit)
      const result = await svc.search({ query, pid, tags, limit })
      if (result.hits.length === 0 && result.total === 0 && result.text.startsWith('could not')) {
        return asNope(result.text, 'refused')
      }
      return {
        ok: true,
        value: neutralizeDeep({
          hits: result.hits,
          total: result.total,
          text: result.text,
        }),
      }
    },
  }

  const write: Record<string, EndpointHandler> = {
    'decisions.link': async (payload) => {
      const raw = payloadOf(payload)
      const id = stringOf(raw.id)
      const entryIds = Array.isArray(raw.entryIds) ? raw.entryIds.filter(t => typeof t === 'string') as string[] : []
      const pid = stringOf(raw.pid) || undefined
      if (id === '') return asNope('decisions.link needs id')
      if (entryIds.length === 0) return asNope('decisions.link needs entryIds')
      const result = await svc.link({ id, entryIds, pid })
      return result.ok
        ? { ok: true, value: neutralizeDeep({ linkedEntries: result.decision?.linkedEntries ?? [], message: result.message }) }
        : asNope(result.message, 'refused')
    },
  }

  return { read, write }
}

/** Point the exported maps at a live service (called from the module's apply). */
export function bindDecisionEndpoints(svc: DecisionService): void {
  const next = decisionEndpoints(svc)
  registry.read = next.read
  registry.write = next.write
}

function routed(kind: 'read' | 'write', endpoint: string): EndpointHandler {
  return async (payload: unknown): Promise<RpcResult<unknown>> => {
    const handler = registry[kind][endpoint]
    if (handler === undefined) {
      return asNope(`decision endpoint is not wired: ${endpoint} (module failed to start?)`, 'not-wired')
    }
    try {
      return await handler(payload)
    } catch (error) {
      return asNope(`endpoint ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`, 'handler-failed')
    }
  }
}

/** Endpoints this module answers on the read channel. */
export const readEndpoints: Record<string, EndpointHandler> = {
  'decisions.list': routed('read', 'decisions.list'),
  'decisions.search': routed('read', 'decisions.search'),
}

/** Endpoints this module answers on the write channel. */
export const writeEndpoints: Record<string, EndpointHandler> = {
  'decisions.link': routed('write', 'decisions.link'),
}
