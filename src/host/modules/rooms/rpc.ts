/**
 * RPC endpoint face for the rooms module. The parent owns the channel mount
 * (`.dev/RPC-ENDPOINTS.md`: one dispatch per channel, module endpoints appended
 * there), so this module exports HANDLER MAPS and never registers a channel.
 *
 * Same convention M6 set in `modules/delegate/rpc.ts`: module-level singleton
 * maps the parent can import at top level, bound to the live service by
 * {@link bindRoomsEndpoints}. Before binding (or after a failed boot) every call
 * answers honestly instead of throwing.
 *
 * Frozen names used here: read `rooms.list`, `rooms.read`, `rooms.status`;
 * write `rooms.create`, `rooms.post`, `rooms.join`, `rooms.leave`, `rooms.delete`.
 * `rooms.spawn` / `rooms.send` belong to the sessions module.
 *
 * `rooms.delete` is the panel's door to the same destructive path the agent tool
 * `cortex_room_delete` uses: two steps, and the token is issued for the room id
 * that actually resolved, so a mistyped id cannot destroy anything.
 *
 * There is no caller session on an RPC call, so a write that needs an author
 * takes it from the payload (`sessionId`, else `label`, else `'ui'`) and the
 * result says so — no silent attribution to a human user (P1).
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import type { RoomService } from './service.ts'
import { refuse } from '../../rpc-error.ts'

/** One endpoint handler: payload in, wire envelope out; never throws. */
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

/** Handlers for the rooms module, against one service instance. */
export function roomsEndpoints(svc: RoomService): { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } {
  const disabled = (): RpcResult<unknown> => asNope('rooms are disabled by config (rooms.enabled = false)', 'disabled')

  const read: Record<string, EndpointHandler> = {
    'rooms.list': async () => {
      const rooms = await svc.list()
      return {
        ok: true,
        value: neutralizeDeep({
          rooms: rooms.map(room => ({
            id: room.id,
            title: room.title,
            lastSeq: room.lastSeq,
            createdAt: room.createdAt,
            createdBy: room.createdBy,
            members: room.members.map(member => ({
              sessionId: member.sessionId ?? null,
              label: member.label,
              status: svc.stateOf(member),
              lastSeen: member.lastActivityAt ?? member.joinedAt ?? null,
            })),
          })),
        }),
      }
    },
    'rooms.read': async (payload) => {
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      if (roomId === '') return asNope('rooms.read needs a roomId')
      const sinceSeq = typeof raw.sinceSeq === 'number' && Number.isFinite(raw.sinceSeq) ? Math.floor(raw.sinceSeq) : undefined
      const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : undefined
      const result = await svc.read(roomId, { ...(sinceSeq === undefined ? {} : { sinceSeq }), ...(limit === undefined ? {} : { limit }) })
      if (!result.ok) return asNope(result.message, 'not-found')
      return {
        ok: true,
        value: neutralizeDeep({
          messages: result.messages.map(message => ({
            seq: message.seq,
            from: message.fromLabel ?? message.fromKind,
            fromKind: message.fromKind,
            text: message.text,
            images: message.images,
            at: message.at,
          })),
        }),
      }
    },
    'rooms.status': async (payload) => {
      const roomId = stringOf(payloadOf(payload).roomId)
      if (roomId === '') return asNope('rooms.status needs a roomId')
      const result = await svc.status(roomId)
      if (!result.ok || result.rows === undefined) return asNope(result.message, 'not-found')
      return { ok: true, value: neutralizeDeep({ members: result.rows, lastSeq: result.room?.lastSeq ?? 0 }) }
    },
  }

  const write: Record<string, EndpointHandler> = {
    'rooms.create': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const title = stringOf(raw.title)
      if (title === '') return asNope('rooms.create needs a title')
      const sessionId = stringOf(raw.sessionId)
      const result = await svc.create({
        title,
        ...(sessionId === '' ? {} : { createdBy: sessionId }),
        ...(sessionId === '' ? {} : { joinAs: { label: stringOf(raw.label) || `session ${clampText(sessionId, 24)}`, sessionId } }),
      })
      return result.ok
        ? { ok: true, value: neutralizeDeep({ room: result.room ?? null, message: result.message }) }
        : asNope(result.message, 'refused')
    },
    'rooms.post': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const text = typeof raw.text === 'string' ? raw.text : ''
      if (roomId === '' || text.trim() === '') return asNope('rooms.post needs roomId and text')
      const sessionId = stringOf(raw.sessionId)
      const images = Array.isArray(raw.imagePaths) ? raw.imagePaths.slice(0, 8) : []
      const result = await svc.post({
        roomId,
        text,
        images,
        ...(sessionId === '' ? {} : { fromSessionId: sessionId }),
        fromLabel: stringOf(raw.label) || (sessionId === '' ? 'ui' : `session ${clampText(sessionId, 24)}`),
        fromKind: sessionId === '' ? 'system' : 'session',
        notify: raw.notify !== false,
      })
      return result.ok
        ? { ok: true, value: neutralizeDeep({ seq: result.seq ?? null, images: result.images ?? [], refused: result.refused ?? [], counts: result.counts ?? null, message: result.message }) }
        : asNope(result.message, 'refused')
    },
    'rooms.join': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const sessionId = stringOf(raw.sessionId)
      if (roomId === '' || sessionId === '') return asNope('rooms.join needs roomId and sessionId')
      const agent = svc.live(sessionId)
      const result = await svc.join(roomId, {
        label: stringOf(raw.label) || `session ${clampText(sessionId, 24)}`,
        sessionId,
        ...(agent?.options?.model === undefined ? {} : { model: agent.options.model }),
        ...(agent?.session?.header?.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
      })
      return result.ok ? { ok: true, value: neutralizeDeep({ message: result.message }) } : asNope(result.message, 'refused')
    },
    'rooms.leave': async (payload) => {
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const sessionId = stringOf(raw.sessionId)
      if (roomId === '' || sessionId === '') return asNope('rooms.leave needs roomId and sessionId')
      const result = await svc.leave(roomId, sessionId)
      return result.ok ? { ok: true, value: neutralizeDeep({ message: result.message }) } : asNope(result.message, 'refused')
    },
    'rooms.delete': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      if (roomId === '') return asNope('rooms.delete needs a roomId')
      const result = await svc.delete({ roomId, confirm: raw.confirm })
      if (!result.ok) return asNope(result.message, 'refused')
      return {
        ok: true,
        value: neutralizeDeep({
          roomId,
          deleted: result.deleted === true,
          ...(result.token !== undefined ? { token: result.token } : {}),
          message: result.message,
        }),
      }
    },
  }

  return { read, write }
}

/** Point the exported maps at a live service (called from `apply`). */
export function bindRoomsEndpoints(svc: RoomService): void {
  const next = roomsEndpoints(svc)
  registry.read = next.read
  registry.write = next.write
}

function routed(kind: 'read' | 'write', endpoint: string): EndpointHandler {
  return async (payload: unknown): Promise<RpcResult<unknown>> => {
    const handler = registry[kind][endpoint]
    if (handler === undefined) {
      return asNope(`room endpoint is not wired: ${endpoint} (module failed to start?)`, 'not-wired')
    }
    try {
      return await handler(payload)
    } catch (error) {
      // A handler must never leak a throw to the transport.
      return asNope(`endpoint ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`, 'handler-failed')
    }
  }
}

/** Endpoints this module answers on `/dsh-cortex-read`. */
export const readEndpoints: Record<string, EndpointHandler> = {
  'rooms.list': routed('read', 'rooms.list'),
  'rooms.read': routed('read', 'rooms.read'),
  'rooms.status': routed('read', 'rooms.status'),
}

/** Endpoints this module answers on `/dsh-cortex-write`. */
export const writeEndpoints: Record<string, EndpointHandler> = {
  'rooms.create': routed('write', 'rooms.create'),
  'rooms.post': routed('write', 'rooms.post'),
  'rooms.join': routed('write', 'rooms.join'),
  'rooms.leave': routed('write', 'rooms.leave'),
  'rooms.delete': routed('write', 'rooms.delete'),
}
