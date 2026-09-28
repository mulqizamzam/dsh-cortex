/**
 * RPC endpoint face for the sessions module. Frozen names from
 * `.dev/RPC-ENDPOINTS.md` are `rooms.spawn` and `rooms.send` (the write
 * channel), so those are the keys exported here even though the tools are
 * `cortex_session_*`. One read endpoint, `sessions.status`, is this module's own
 * addition (the UI needs "can this host spawn at all?" before it shows a
 * button); TODO(PARENT): append it to RPC-ENDPOINTS.md at integration.
 *
 * Same mount rule as the rooms module: the parent owns the channel, this module
 * exports handler maps bound to a live service, and nothing throws at the
 * transport.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import type { RoomService } from '../rooms/service.ts'
import type { ModuleDeps } from '../../types.ts'
import { sendToSession, spawnFactory, spawnSession, spawnedSessionIds } from './spawn.ts'
import type { SpawnDeps } from './spawn.ts'
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

const registry: { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } = { read: {}, write: {} }

export function sessionEndpoints(svc: SpawnDeps): { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } {
  const read: Record<string, EndpointHandler> = {
    'sessions.status': () => {
      const spawned = spawnedSessionIds()
      const rooms = svc.rooms
      return {
        ok: true,
        value: {
          canSpawn: spawnFactory(svc.deps.ctx.agents) !== undefined,
          spawnedByThisPlugin: spawned.map(id => neutralize(id)),
          live: rooms.liveAgents().map(agent => ({
            sessionId: agent.id,
            status: agent.status,
            cwd: agent.session?.header?.cwd === undefined ? null : clampText(agent.session.header.cwd, 120),
          })),
        },
      }
    },
  }

  const write: Record<string, EndpointHandler> = {
    'rooms.spawn': async (payload) => {
      const raw = payloadOf(payload)
      const result = await spawnSession({
        roomId: stringOf(raw.roomId),
        label: stringOf(raw.label),
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
        ...(raw.model === undefined ? {} : { model: raw.model }),
        ...(raw.provider === undefined ? {} : { provider: raw.provider }),
        ...(stringOf(raw.sessionId) === '' ? {} : { fromSessionId: stringOf(raw.sessionId) }),
      }, svc)
      return result.ok
        ? { ok: true, value: { sessionId: result.sessionId ?? null, message: neutralize(result.message) } }
        : asNope(result.message, 'refused')
    },
    'rooms.send': async (payload) => {
      const raw = payloadOf(payload)
      const result = await sendToSession({
        sessionId: stringOf(raw.sessionId),
        text: typeof raw.text === 'string' ? raw.text : '',
        ...(stringOf(raw.roomId) === '' ? {} : { roomId: stringOf(raw.roomId) }),
        ...(raw.imagePaths === undefined ? {} : { images: Array.isArray(raw.imagePaths) ? raw.imagePaths.slice(0, 8) : [] }),
      }, svc)
      return result.ok
        ? { ok: true, value: { seq: result.seq ?? null, message: neutralize(result.message) } }
        : asNope(result.message, 'refused')
    },
  }

  return { read, write }
}

/** Point the exported maps at a live service (called from `apply`). */
export function bindSessionEndpoints(svc: SpawnDeps): void {
  const next = sessionEndpoints(svc)
  registry.read = next.read
  registry.write = next.write
}

function routed(kind: 'read' | 'write', endpoint: string): EndpointHandler {
  return async (payload: unknown): Promise<RpcResult<unknown>> => {
    const handler = registry[kind][endpoint]
    if (handler === undefined) return asNope(`session endpoint is not wired: ${endpoint} (module failed to start?)`, 'not-wired')
    try {
      return await handler(payload)
    } catch (error) {
      return asNope(`endpoint ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`, 'handler-failed')
    }
  }
}

/** Endpoints this module answers on `/dsh-cortex-read` (its own addition). */
export const readEndpoints: Record<string, EndpointHandler> = {
  'sessions.status': routed('read', 'sessions.status'),
}

/** Endpoints this module answers on `/dsh-cortex-write` (frozen names). */
export const writeEndpoints: Record<string, EndpointHandler> = {
  'rooms.spawn': routed('write', 'rooms.spawn'),
  'rooms.send': routed('write', 'rooms.send'),
}

/** Build the deps pair the sessions code needs from module deps + rooms. */
export function sessionDeps(deps: ModuleDeps, rooms: RoomService): SpawnDeps {
  return { deps, rooms }
}
