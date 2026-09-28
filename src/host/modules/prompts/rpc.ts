/**
 * M4 · RPC endpoint face for the prompts domain (`.dev/RPC-ENDPOINTS.md`).
 *
 * The parent owns the channel mount; this module exports HANDLER MAPS keyed by
 * the frozen endpoint names and never registers a channel of its own. Same
 * convention M5 set in `modules/rooms/rpc.ts`: a module-level registry bound to
 * the live service by {@link bindPromptEndpoints}, so a call before `apply()`
 * succeeded answers honestly instead of throwing at the transport.
 *
 * Frozen names used here — read `prompts.list`, `prompts.get`; write
 * `prompts.save`, `prompts.toggle`, `prompts.delete`, `inject.now`. EVERY one of
 * them (reads included) answers the same refusal while `prompts.enabled` is off:
 * a switched-off domain has nothing to show, and a half-answer is how a panel
 * starts lying about state.
 *
 * The human/AI split, which is the whole point of this file: an RPC call on the
 * loopback-fenced channel is a click, not a turn, so `prompts.save` writes the
 * library DIRECTLY (like `todo.add`) while `cortex_prompt_save` can only file a
 * proposal. `prompts.delete` is destructive, so it requires the literal
 * confirm string `DELETE`. And `inject.now` names its session explicitly
 * (`targetSessionId`), because a panel click carries no agent to infer one from
 * — the AI tool path refuses any session but the caller's own.
 */
import { clampText } from '../../../lib/caps.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import { refuse } from '../../rpc-error.ts'
import { queueLines } from './tools.ts'
import type { PromptsService } from './service.ts'

/** One endpoint handler: payload in, wire envelope out; never throws. */
export type EndpointHandler = (payload: unknown) => Promise<RpcResult<unknown>> | RpcResult<unknown>

/** The optional `scope` object the contract allows on any endpoint. */
export interface EndpointScope {
  sessionId?: unknown
}

/** A library row as the panel sees it: size, never the body (that's `prompts.get`). */
export interface PromptSummary {
  id: string
  title: string
  category: string | null
  enabled: boolean
  bodyChars: number
  createdAt: string
  updatedAt: string
}

/** Ceiling on the body the panel is handed (contract: 32KB for `prompts.get`). */
export const UI_BODY_CHARS = 32_768

const nope = (message: string, code = 'refused'): RpcResult<unknown> =>
  refuse(neutralize(clampText(message, 400)), code)

function body(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `scope.sessionId` (contract) or the flat `targetSessionId` the endpoint names. */
function targetOf(raw: Record<string, unknown>): string {
  const scope = (raw.scope ?? {}) as EndpointScope
  return textOf(scope.sessionId) || textOf(raw.targetSessionId)
}

const summary = (doc: { id: string; title: string; category?: string; enabled: boolean; body: string; createdAt: string; updatedAt: string }): PromptSummary => ({
  id: doc.id,
  title: doc.title,
  category: doc.category ?? null,
  enabled: doc.enabled === true,
  bodyChars: doc.body.length,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
})

const registry: { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } = { read: {}, write: {} }

/** Handlers for the prompts domain, against one service instance. */
export function promptEndpoints(svc: PromptsService): {
  read: Record<string, EndpointHandler>
  write: Record<string, EndpointHandler>
} {
  const disabled = (): RpcResult<unknown> => nope(svc.disabledMessage, 'disabled')

  const read: Record<string, EndpointHandler> = {
    'prompts.list': async (payload: unknown) => {
      if (!svc.enabled) return disabled()
      const raw = body(payload)
      const category = textOf(raw.category)
      const includeDisabled = raw.includeDisabled !== false
      const docs = await svc.list({ ...(category === '' ? {} : { category }), ...(includeDisabled ? {} : { enabled: true }) })
      return {
        ok: true,
        value: neutralizeDeep({
          docs: docs.map(summary),
          total: docs.length,
          includeDisabled,
          ...(category === '' ? {} : { category }),
        }),
      }
    },

    'prompts.get': async (payload: unknown) => {
      if (!svc.enabled) return disabled()
      const raw = body(payload)
      const id = textOf(raw.id)
      if (id === '' || !isSafeKey(id)) return nope('prompts.get needs an id')
      const doc = await svc.get(id)
      if (doc === null) return nope(`no saved prompt ${id}`, 'not-found')
      return {
        ok: true,
        value: neutralizeDeep({
          doc: {
            ...summary(doc),
            body: doc.body.slice(0, UI_BODY_CHARS),
            truncated: doc.body.length > UI_BODY_CHARS,
          },
        }),
      }
    },
  }

  const write: Record<string, EndpointHandler> = {
    // The human path: the panel already knows what it wants, so this writes the
    // library directly (same rule as `todo.add`), pending-gate-free.
    'prompts.save': async (payload: unknown) => {
      if (!svc.enabled) return disabled()
      const raw = body(payload)
      const title = textOf(raw.title)
      const text = typeof raw.body === 'string' ? raw.body : ''
      if (title === '' || text.trim() === '') return nope('prompts.save needs title and body')
      const id = textOf(raw.id)
      if (id !== '' && !isSafeKey(id)) return nope('prompts.save id is not a prompt id')
      const category = textOf(raw.category)
      const result = await svc.saveDoc({
        ...(id === '' ? {} : { id }),
        title,
        body: text,
        ...(category === '' ? {} : { category }),
      })
      return result.ok && result.doc !== undefined && result.doc !== null
        ? { ok: true, value: neutralizeDeep({ doc: summary(result.doc), message: result.message }) }
        : nope(result.message, result.code ?? 'refused')
    },

    'prompts.toggle': async (payload: unknown) => {
      if (!svc.enabled) return disabled()
      const raw = body(payload)
      const id = textOf(raw.id)
      if (id === '' || !isSafeKey(id)) return nope('prompts.toggle needs an id')
      if (typeof raw.enabled !== 'boolean') return nope('prompts.toggle needs enabled as a boolean')
      const result = await svc.toggle(id, raw.enabled)
      return result.ok && result.doc !== undefined && result.doc !== null
        ? { ok: true, value: neutralizeDeep({ doc: summary(result.doc), message: result.message }) }
        : nope(result.message, result.code ?? 'refused')
    },

    'prompts.delete': async (payload: unknown) => {
      if (!svc.enabled) return disabled()
      const raw = body(payload)
      const id = textOf(raw.id)
      if (id === '' || !isSafeKey(id)) return nope('prompts.delete needs an id')
      if (raw.confirm !== 'DELETE') return nope('prompts.delete needs confirm: "DELETE" exactly; nothing was deleted', 'confirm-required')
      const result = await svc.remove(id, raw.confirm)
      return result.ok
        ? { ok: true, value: neutralizeDeep({ id, deleted: true, message: result.message }) }
        : nope(result.message, result.code ?? 'refused')
    },

    // A panel click has no agent to inherit a session from, so the session is
    // named here; the label inside the injected block stays honest either way.
    'inject.now': async (payload: unknown) => {
      if (!svc.enabled) return disabled()
      const raw = body(payload)
      const sessionId = targetOf(raw)
      if (sessionId === '') return nope('inject.now needs targetSessionId (a panel click carries no session of its own)')
      const mode = raw.mode === 'once' || raw.mode === 'sticky' || raw.mode === 'clear' ? raw.mode : undefined
      if (mode === undefined) return nope("inject.now needs mode: 'once' | 'sticky' | 'clear'")
      const promptId = textOf(raw.promptId)
      const text = typeof raw.text === 'string' ? raw.text : ''
      if (promptId !== '' && !isSafeKey(promptId)) return nope('inject.now promptId is not a prompt id')
      if (promptId !== '' && text.trim() !== '') return nope('inject.now takes either promptId or text, not both')
      if (mode !== 'clear' && promptId === '' && text.trim() === '') return nope('inject.now needs promptId or text')
      const result = await svc.inject({
        sessionId,
        mode,
        ...(promptId === '' ? {} : { promptId }),
        ...(text.trim() === '' ? {} : { text }),
      })
      return result.ok
        ? {
            ok: true,
            value: neutralizeDeep({
              sessionId,
              queue: (result.rows ?? []).map(row => ({
                promptId: row.promptId,
                mode: row.mode,
                rounds: row.rounds,
                title: row.title,
                at: row.at,
              })),
              lines: queueLines(result.rows ?? []),
              message: result.message,
            }),
          }
        : nope(result.message, result.code ?? 'refused')
    },
  }

  return { read, write }
}

/** Point the exported maps at a live service (called from `apply`). */
export function bindPromptEndpoints(svc: PromptsService): void {
  const next = promptEndpoints(svc)
  registry.read = next.read
  registry.write = next.write
}

function routed(kind: 'read' | 'write', endpoint: string): EndpointHandler {
  return async (payload: unknown): Promise<RpcResult<unknown>> => {
    const handler = registry[kind][endpoint]
    if (handler === undefined) return nope(`prompts endpoint is not wired: ${endpoint} (module failed to start?)`, 'not-wired')
    try {
      return await handler(payload)
    } catch (error) {
      // A handler must never leak a throw to the transport (P4).
      return nope(`endpoint ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`, 'handler-failed')
    }
  }
}

/** Endpoints this module answers on `/dsh-cortex-read`. */
export const readEndpoints: Record<string, EndpointHandler> = {
  'prompts.list': routed('read', 'prompts.list'),
  'prompts.get': routed('read', 'prompts.get'),
}

/** Endpoints this module answers on `/dsh-cortex-write`. */
export const writeEndpoints: Record<string, EndpointHandler> = {
  'prompts.save': routed('write', 'prompts.save'),
  'prompts.toggle': routed('write', 'prompts.toggle'),
  'prompts.delete': routed('write', 'prompts.delete'),
  'inject.now': routed('write', 'inject.now'),
}

/** Ids this module answers on each channel, for the parent's wiring report. */
export const READ_ENDPOINT_NAMES: readonly string[] = Object.keys(readEndpoints)
export const WRITE_ENDPOINT_NAMES: readonly string[] = Object.keys(writeEndpoints)
