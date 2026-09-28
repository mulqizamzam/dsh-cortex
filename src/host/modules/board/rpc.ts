/**
 * Board RPC endpoints. Follows the same pattern as rooms/rpc.ts:
 * module-level registry bound to a live service; handlers answer honestly
 * before binding; never throws to the transport.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import type { BoardStatus } from '../../types.ts'
import type { BoardService } from './service.ts'
import { refuse } from '../../rpc-error.ts'

export type EndpointHandler = (payload: unknown) => Promise<RpcResult<unknown>> | RpcResult<unknown>

const asNope = (message: string, code = 'refused'): RpcResult<unknown> =>
  refuse(neutralize(clampText(message, 400)), code)

/** The three columns a card may sit in; the source of every status check here. */
const BOARD_STATUS_VALUES: readonly BoardStatus[] = ['backlog', 'in-progress', 'done']

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

const registry: { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } = { read: {}, write: {} }

/** Handlers for the board module against one live service. */
export function boardEndpoints(svc: BoardService): { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } {
  const disabled = (): RpcResult<unknown> => asNope('board is disabled by config (board.enabled = false)', 'disabled')

  const read: Record<string, EndpointHandler> = {
    'boards.list': async (payload) => {
      const roomId = stringOf(payloadOf(payload).roomId)
      if (roomId === '') return asNope('boards.list needs a roomId')
      const result = await svc.list(roomId)
      if (!result.ok) return asNope(result.message, 'refused')
      return { ok: true, value: neutralizeDeep({ boards: result.boards }) }
    },
    'boards.get': async (payload) => {
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const boardId = stringOf(raw.boardId)
      if (roomId === '' || boardId === '') return asNope('boards.get needs roomId and boardId')
      const includeComments = raw.includeComments === true
      const commentLimit = typeof raw.commentLimit === 'number' && Number.isFinite(raw.commentLimit)
        ? Math.max(1, Math.min(200, Math.floor(raw.commentLimit)))
        : 50
      const result = await svc.get(roomId, boardId, { includeComments, commentLimit })
      if (!result.ok) return asNope(result.message, 'not-found')
      return {
        ok: true,
        value: neutralizeDeep({
          cards: (result.board ?? []).map(c => ({
            id: c.id,
            title: c.title,
            status: c.status,
            owner: c.ownerId ?? null,
            dependencies: c.dependencies,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            ...(c.description !== undefined ? { description: c.description } : {}),
          })),
          comments: (result.comments ?? []).map(c => ({
            id: c.id,
            cardId: c.cardId,
            author: c.authorLabel ?? c.authorSessionId ?? null,
            text: c.text,
            at: c.createdAt,
          })),
        }),
      }
    },
  }

  const write: Record<string, EndpointHandler> = {
    'boards.create': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const title = stringOf(raw.title)
      if (roomId === '' || title === '') return asNope('boards.create needs roomId and title')
      const sessionId = stringOf(raw.sessionId)
      const result = await svc.create({
        roomId,
        title,
        ...(sessionId === '' ? {} : { createdBy: sessionId }),
      })
      return result.ok
        ? { ok: true, value: neutralizeDeep({ boardId: result.boardId, message: result.message }) }
        : asNope(result.message, 'refused')
    },
    'boards.addCard': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const boardId = stringOf(raw.boardId)
      const title = stringOf(raw.title)
      if (roomId === '' || boardId === '' || title === '') return asNope('boards.addCard needs roomId, boardId and title')
      const deps = Array.isArray(raw.dependencies) ? raw.dependencies.filter(d => typeof d === 'string') : []
      // The wire value is an untrusted string; narrow it to the union instead of
      // letting `includes` vouch for a `string` that the type then rejects.
      const status = BOARD_STATUS_VALUES.find(s => s === raw.status)
      const result = await svc.addCard({
        roomId,
        boardId,
        title,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(typeof raw.ownerId === 'string' ? { ownerId: raw.ownerId } : {}),
        dependencies: deps as string[],
      })
      return result.ok
        ? { ok: true, value: neutralizeDeep({ card: result.card ?? null, message: result.message }) }
        : asNope(result.message, 'refused')
    },
    'boards.moveCard': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const boardId = stringOf(raw.boardId)
      const cardId = stringOf(raw.cardId)
      const status = stringOf(raw.status)
      if (roomId === '' || boardId === '' || cardId === '') return asNope('boards.moveCard needs roomId, boardId and cardId')
      if (!['backlog', 'in-progress', 'done'].includes(status)) return asNope('status must be backlog, in-progress, or done')
      const result = await svc.moveCard(roomId, boardId, cardId, status as never)
      return result.ok
        ? { ok: true, value: neutralizeDeep({ card: result.card ?? null, message: result.message }) }
        : asNope(result.message, 'refused')
    },
    'boards.comment': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const boardId = stringOf(raw.boardId)
      const cardId = stringOf(raw.cardId)
      const text = stringOf(raw.text)
      if (roomId === '' || boardId === '' || cardId === '' || text === '') return asNope('boards.comment needs roomId, boardId, cardId and text')
      const sessionId = stringOf(raw.sessionId)
      const result = await svc.addComment({
        roomId,
        boardId,
        cardId,
        text,
        ...(sessionId === '' ? { authorLabel: 'ui' } : { authorSessionId: sessionId, authorLabel: `session ${clampText(sessionId, 24)}` }),
      })
      return result.ok
        ? { ok: true, value: neutralizeDeep({ comment: result.comment ?? null, message: result.message }) }
        : asNope(result.message, 'refused')
    },
    'boards.delete': async (payload) => {
      if (!svc.enabled) return disabled()
      const raw = payloadOf(payload)
      const roomId = stringOf(raw.roomId)
      const boardId = stringOf(raw.boardId)
      if (roomId === '' || boardId === '') return asNope('boards.delete needs roomId and boardId')
      const result = await svc.delete(roomId, boardId)
      return result.ok
        ? { ok: true, value: neutralizeDeep({ message: result.message }) }
        : asNope(result.message, 'refused')
    },
  }

  return { read, write }
}

/** Point the exported maps at a live service (called from the module's apply). */
export function bindBoardEndpoints(svc: BoardService): void {
  const next = boardEndpoints(svc)
  registry.read = next.read
  registry.write = next.write
}

function routed(kind: 'read' | 'write', endpoint: string): EndpointHandler {
  return async (payload: unknown): Promise<RpcResult<unknown>> => {
    const handler = registry[kind][endpoint]
    if (handler === undefined) {
      return asNope(`board endpoint is not wired: ${endpoint} (module failed to start?)`, 'not-wired')
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
  'boards.list': routed('read', 'boards.list'),
  'boards.get': routed('read', 'boards.get'),
}

/** Endpoints this module answers on the write channel. */
export const writeEndpoints: Record<string, EndpointHandler> = {
  'boards.create': routed('write', 'boards.create'),
  'boards.addCard': routed('write', 'boards.addCard'),
  'boards.moveCard': routed('write', 'boards.moveCard'),
  'boards.comment': routed('write', 'boards.comment'),
  'boards.delete': routed('write', 'boards.delete'),
}
