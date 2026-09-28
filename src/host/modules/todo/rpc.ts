/**
 * RPC endpoint face of the todo module (`.dev/RPC-ENDPOINTS.md`).
 *
 * The parent owns the channel mount; this module only exports handler maps
 * keyed by the frozen endpoint names, in the same shape the delegate module
 * uses so one merge in `src/host/rpc.ts` covers both.
 *
 * UI path rule from the contract: `todo.add` on the WRITE channel is the
 * human path — it writes immediately and does NOT go through the pending
 * queue. The pending queue exists to gate AI-authored content, and an RPC
 * call on the loopback-fenced channel is by construction a click, not a turn.
 */
import { clampText } from '../../../lib/caps.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import { refuse } from '../../rpc-error.ts'
import { formatTodoList } from './digest.ts'
import type { TodoService } from './service.ts'
import { scopeFromPayload, toTrack } from './service.ts'

/** Same handler contract the parent's dispatcher expects (see modules/delegate/service.ts). */
export type EndpointHandler = (payload: unknown) => Promise<RpcResult<unknown>> | RpcResult<unknown>

/** Re-exported so the sibling M3 modules read one RPC payload shape. */
export { scopeFromPayload }

const nope = (message: string, code = 'refused'): RpcResult<unknown> =>
  refuse(neutralize(message), code)

function body(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

/** Endpoint names answered on `/dsh-cortex-read`. */
export function todoReadEndpoints(svc: TodoService): Record<string, EndpointHandler> {
  return {
    'todo.list': async (payload: unknown) => {
      const a = body(payload)
      const scope = scopeFromPayload(a)
      const tracks = Array.isArray(a.tracks) ? a.tracks.map(item => toTrack(item)).filter((item): boolean => item !== undefined) : undefined
      const openOnly = a.openOnly === undefined ? true : a.openOnly === true
      const items = await svc.allTodos({
        ...(tracks === undefined || tracks.length === 0 ? {} : { tracks: tracks as never }),
        ...(scope.pid === undefined ? {} : { pid: scope.pid }),
        openOnly,
      })
      const today = svc.today()
      return {
        ok: true,
        value: neutralizeDeep({
          items: items.map(item => ({
            id: item.id,
            track: item.track,
            text: clampText(item.text, 300),
            done: item.done === true,
            important: item.important === true,
            urgent: item.urgent === true,
            due: item.due ?? null,
            overdue: item.done !== true && typeof item.due === 'string' && item.due < today,
            createdAt: item.createdAt,
            completedAt: item.completedAt ?? null,
          })),
          lines: formatTodoList(items, today).slice(0, 200),
          truncated: items.length > 200,
        }),
      }
    },
  }
}

/** Endpoint names answered on `/dsh-cortex-write`. */
export function todoWriteEndpoints(svc: TodoService): Record<string, EndpointHandler> {
  return {
    'todo.add': async (payload: unknown) => {
      const a = body(payload)
      const scope = scopeFromPayload(a)
      const track = toTrack(a.track)
      if (track === undefined) return nope('track must be one of life, work, daily, project')
      const text = typeof a.text === 'string' ? a.text.trim() : ''
      if (text === '') return nope('text is required')
      // A UI click has no agent to inherit a repo from, so the project track
      // needs an explicit projectId in the scope (never a guess, P8).
      const result = await svc.addTodo({
        track,
        text,
        ...(scope.pid === undefined ? {} : { pid: scope.pid }),
        ...(typeof a.important === 'boolean' ? { important: a.important } : {}),
        ...(typeof a.urgent === 'boolean' ? { urgent: a.urgent } : {}),
        ...(a.due !== undefined ? { due: a.due } : {}),
      }, undefined)
      return result.ok && result.item !== undefined
        ? { ok: true, value: neutralizeDeep(result.item) }
        : nope(result.message, 'refused')
    },
    // A malformed id is a bad request; a well-formed id that matches no row is
    // a refusal. The panel needs the two different answers.
    'todo.complete': async (payload: unknown) => {
      const a = body(payload)
      if (typeof a.id !== 'string' || !isSafeKey(a.id)) return nope('id must be a todo id')
      const scope = scopeFromPayload(a)
      const result = await svc.completeTodo(a.id, undefined, scope.pid)
      return result.ok ? { ok: true, value: neutralizeDeep({ id: a.id, done: true }) } : nope(result.message, 'refused')
    },
    'todo.remove': async (payload: unknown) => {
      const a = body(payload)
      if (typeof a.id !== 'string' || !isSafeKey(a.id)) return nope('id must be a todo id')
      const scope = scopeFromPayload(a)
      const result = await svc.removeTodo(a.id, undefined, scope.pid)
      return result.ok ? { ok: true, value: neutralizeDeep({ id: a.id, removed: true }) } : nope(result.message, 'refused')
    },
  }
}
