/**
 * RPC endpoint face of the logs module.
 *
 * `/dsh-cortex-read` carries `logs.read {scope, date?, lastDays?}` →
 * `{ date, text }[]` (the shape `.dev/RPC-ENDPOINTS.md` froze). There is NO
 * `logs.*` write endpoint: the contract has none, and a human typing into the
 * panel is a different product decision from an AI recording what it just did
 * (P3 — no handler nobody asked for). The empty `writeEndpoints` is exported
 * anyway so the parent can merge every module with one loop.
 *
 * One store read per requested day keeps the per-day shape honest: a day with
 * no file renders as an empty string for that day, not as a missing row.
 */
import { isIsoDate, isSafeKey } from '../../../lib/ids.ts'
import type { RpcResult } from '../../dsh.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import { MAX_LAST_DAYS } from './service.ts'
import type { LogService } from './service.ts'
import { refuse } from '../../rpc-error.ts'

export type EndpointHandler = (payload: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } }>

const nope = (message: string, code = 'refused'): RpcResult<unknown> =>
  refuse(neutralize(message), code)

function body(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

/**
 * Which project the row belongs to. The generic RPC `scope` object is spelled
 * `projectId` at the top level here because the frozen contract already uses
 * `scope` for the LOG target ('project' | 'daily'); both spellings are read so
 * the panel can send either. Never a guess (P8).
 */
function projectIdOf(a: Record<string, unknown>): string | undefined {
  const direct = typeof a.projectId === 'string' && isSafeKey(a.projectId) ? a.projectId : undefined
  const nested = (a.scope !== null && typeof a.scope === 'object' ? (a.scope as { projectId?: unknown }).projectId : undefined)
  const viaNested = typeof nested === 'string' && isSafeKey(nested) ? nested : undefined
  return direct ?? viaNested
}

export function logsReadEndpoints(svc: LogService): Record<string, EndpointHandler> {
  return {
    'logs.read': async (payload: unknown) => {
      const a = body(payload)
      const scope = a.scope === 'daily' ? 'daily' : a.scope === 'project' ? 'project' : undefined
      if (scope === undefined) return nope("scope must be 'project' or 'daily'")
      const pid = scope === 'daily' ? undefined : projectIdOf(a)
      if (scope === 'project' && pid === undefined) return nope('the project log needs a projectId (the panel knows it from ping/state)')
      const date = typeof a.date === 'string' && isIsoDate(a.date.trim()) ? a.date.trim() : undefined
      if (a.date !== undefined && date === undefined) return nope('date must be YYYY-MM-DD')
      if (a.lastDays !== undefined && (typeof a.lastDays !== 'number' || !Number.isFinite(a.lastDays))) {
        return nope('lastDays must be a number of days')
      }
      const rawDays = typeof a.lastDays === 'number' ? Math.floor(a.lastDays) : 1
      const days = date !== undefined ? 1 : Math.max(1, rawDays)
      if (rawDays > MAX_LAST_DAYS) return nope(`lastDays is capped at ${String(MAX_LAST_DAYS)}`)
      const read = await svc.readDays({ scope, ...(pid === undefined ? {} : { pid }), ...(date === undefined ? {} : { date }), lastDays: days }, undefined)
      if (!read.ok) return nope(read.message, 'refused')
      return { ok: true as const, value: neutralizeDeep({ scope, days: read.rows }) }
    },
  }
}
