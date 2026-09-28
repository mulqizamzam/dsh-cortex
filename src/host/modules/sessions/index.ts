/**
 * M5 sessions module face (DISPATCH integration rule): exports
 * `{ name, TOOLS, apply, readEndpoints, writeEndpoints }`. The parent appends it
 * to `MODULES` and routes the endpoint maps; it shares ONE {@link RoomService}
 * with the rooms module (cached per state root), so the delivery ledger cannot
 * split in two.
 *
 * Order matters at integration: the rooms module must be applied first, but this
 * module does not assume it — `roomsService(deps)` creates the service on
 * demand, and each module registers only its own tools/seam.
 *
 * Design rulings this module honours:
 *  - spawn ONLY through `ctx.agents.create`, feature-detected (HOST-API §6): no
 *    invented host API, no client-side fallback, and an honest refusal that
 *    points at `cortex_room_join` when the factory is absent;
 *  - a spawn cwd is guarded, never trusted (see `spawn.ts`);
 *  - delivery goes through the same wake disposition + counts as room posts, so
 *    `cortex_session_send` cannot become a quieter side channel.
 */
import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { roomsService } from '../rooms/service.ts'
import { bindSessionEndpoints, sessionDeps } from './rpc.ts'
import { spawnFactory } from './spawn.ts'
import { sessionTools } from './tools.ts'

export const name = 'sessions'

/** Tool ids this module owns. */
export const TOOLS = ['cortex_session_spawn', 'cortex_session_send'] as const

export { readEndpoints, writeEndpoints } from './rpc.ts'
export { spawnFactory, checkSpawnCwd, newSessionId, spawnedSessionIds, liveSpawnedCount, recallSpawnedSession, SPAWN_CWD_ALLOWLIST, SPAWN_LIMIT } from './spawn.ts'
export type { SpawnInput, SpawnOutcome, SendInput, SendOutcome } from './spawn.ts'
export { renderHandoff, collectHandoff, HANDOFF_BUDGET_CHARS, HANDOFF_LOG_DAYS, HANDOFF_TODO_LIMIT, HANDOFF_LOG_LINES } from './handoff.ts'
export type { HandoffInput, HandoffResult, HandoffSource } from './handoff.ts'

export function apply(deps: ModuleDeps): void {
  const svc = sessionDeps(deps, roomsService(deps))
  bindSessionEndpoints(svc)

  let registered = 0
  for (const definition of sessionTools(svc)) {
    const result = registerToolSafe(deps.ctx, definition)
    if (result.ok) registered += 1
    else deps.warn(`sessions: registration refused for ${result.name} (${result.error ?? 'unknown'})`)
  }
  if (registered === 0) {
    throw new Error(`no session tool could be registered (${String(TOOLS.length)} refused); see the warnings above`)
  }

  const canSpawn = spawnAvailable(deps)
  deps.log(`sessions: ready (tools=${String(registered)}/${String(TOOLS.length)}, hostCanSpawn=${String(canSpawn)}${canSpawn ? '' : ' - cortex_session_spawn will refuse and point at cortex_room_join'})`)
}

/** Whether this host exposes the agent factory (feature-detect, no calls). */
export function spawnAvailable(deps: ModuleDeps): boolean {
  return spawnFactory(deps.ctx?.agents) !== undefined
}
