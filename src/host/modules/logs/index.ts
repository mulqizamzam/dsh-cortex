/**
 * M3 · logs module face: `{ name, TOOLS, apply, readEndpoints, writeEndpoints }`.
 *
 * The G-06 nudge is wired here and nowhere else: `logReview.everyTurns` (0 =
 * off by default, P3) counts a session's finished turns on `session/event`
 * `turn/end` and releases ONE labelled line into the next assembly through the
 * module's own `cortex:logs` context. The program never writes a log line and
 * never claims to have summarised the session — it only asks.
 */
import { registerLifecycle, registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { LogService } from './service.ts'
import { logTools } from './tools.ts'
import type { EndpointHandler } from './rpc.ts'
import { logsReadEndpoints } from './rpc.ts'
import { refuse } from '../../rpc-error.ts'

export const name = 'logs'
export const TOOLS = ['cortex_log_append', 'cortex_log_read'] as const

export { LogService, logsReadEndpoints }
export { NUDGE_CONTEXT_NAME, NUDGE_CONTEXT_ORDER, TurnNudge, everyTurnsOf, nudgeLine } from './nudge.ts'
export { MAX_LAST_DAYS, READ_LINE_CHARS, READ_MAX_LINES, shapeLogText } from './service.ts'

let service: LogService | null = null

/** The live service after `apply` (tests, status reporting, integration). */
export function getLogService(): LogService | null {
  return service
}

const route = (endpoint: string): EndpointHandler =>
  async (payload: unknown) => {
    if (service === null) return refuse('log endpoints are not wired (module failed to start?)', 'not-wired')
    const handler = logsReadEndpoints(service)[endpoint]
    if (handler === undefined) return refuse(`unknown log read endpoint: ${String(endpoint)}`, 'unknown-endpoint')
    try {
      return await handler(payload)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error), 'handler-failed')
    }
  }

export const readEndpoints: Record<string, EndpointHandler> = { 'logs.read': route('logs.read') }

/** Frozen contract: the log has no human write path in v1 (see rpc.ts). */
export const writeEndpoints: Record<string, EndpointHandler> = {}

export function apply(deps: ModuleDeps): void {
  const svc = new LogService({ deps })
  service = svc
  // F10: same ownership rule as the todo module — the host's fiber unwinds this
  // instance (listener + nudge seam + per-session state) and the read endpoints
  // answer `not-wired` instead of a superseded service. Identity-guarded so a
  // late release cannot clear the live instance.
  registerLifecycle(deps.ctx, () => {
    if (service !== svc) return
    service = null
    svc.dispose()
  }, 'dsh-cortex:logs service', deps.warn)
  svc.install()
  // Retention at mount: a state root that was never written this process may
  // still hold day files past `retention.dailyLogDays`. Fire-and-forget — the
  // boot never waits on disk (same rule as the store scaffold).
  void svc.prune('daily').catch((error: unknown) => {
    deps.warn(`logs: mount prune failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  let refused = 0
  for (const definition of logTools(svc)) {
    const registered = registerToolSafe(deps.ctx, definition)
    if (!registered.ok) {
      refused += 1
      deps.warn(`logs: registration refused: ${registered.name}: ${registered.error ?? 'unknown'}`)
    }
  }
  if (refused === TOOLS.length && !svc.hasContextSeam) {
    throw new Error('logs: neither the tools nor the review-nudge seam could be mounted')
  }
  deps.log(`logs: ready (seam=${String(svc.hasContextSeam)}, tools=${String(TOOLS.length - refused)}/${String(TOOLS.length)}, logReview.everyTurns=${String(svc.everyTurns)})`)
}
