/**
 * M5 rooms module face (DISPATCH integration rule): exports
 * `{ name, TOOLS, apply, readEndpoints, writeEndpoints }`. The parent appends
 * this to `MODULES` in `src/host/index.ts` and routes the endpoint maps into the
 * two RPC channels at integration; nothing here touches a shared file and
 * nothing here registers an RPC channel of its own.
 *
 * What the module owns:
 *  - the seven `cortex_room_*` tools (DESIGN §4);
 *  - the `cortex:rooms` per-turn injection seam at order 42 (room mail, ≤5
 *    messages/turn, always labelled, consumed via the per-session ledger);
 *  - the delivery ledger in `service.ts`, shared with the sessions module
 *    through {@link roomsService} so both entry points see ONE queue.
 *
 * What it deliberately does NOT do:
 *  - it never sends a message as `source.kind = 'user'` (G-02);
 *  - it never copies an image from outside the plugin state root (`images.ts`);
 *  - it never throws out of `apply()` unless the tools are useless (P4): a
 *    failed context registration is logged and reported, mail then arrives via
 *    `cortex_room_read` only.
 */
import { registerLifecycle, registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { registerRoomContext } from './context.ts'
import { bindRoomsEndpoints } from './rpc.ts'
import { roomsService } from './service.ts'
import type { RoomService } from './service.ts'
import { roomTools } from './tools.ts'

export const name = 'rooms'

/** Tool ids this module owns (the wiring loop reports them in cortex_status). */
export const TOOLS = [
  'cortex_room_create',
  'cortex_room_list',
  'cortex_room_join',
  'cortex_room_post',
  'cortex_room_read',
  'cortex_room_status',
  'cortex_room_delete',
] as const

export { readEndpoints, writeEndpoints } from './rpc.ts'
export { roomsService, resetRoomsService } from './service.ts'
export type { RoomService }
export { ROOMS_CONTEXT_NAME, ROOMS_CONTEXT_ORDER, roomsContextText } from './context.ts'

export function apply(deps: ModuleDeps): void {
  const svc = roomsService(deps)
  bindRoomsEndpoints(svc)
  // F10: the cache above is module-scope, so without this the next boot would
  // inherit THIS instance — its queue, its primed marks and its captured deps
  // (old store, old config reader, old context). Release it with the fiber.
  registerLifecycle(deps.ctx, () => { svc.dispose() }, 'dsh-cortex:rooms service', deps.warn)

  const probe = (): boolean => typeof deps.ctx?.agents?.create === 'function'
  let registered = 0
  for (const definition of roomTools(svc, probe)) {
    const result = registerToolSafe(deps.ctx, definition)
    if (result.ok) registered += 1
    else deps.warn(`rooms: registration refused for ${result.name} (${result.error ?? 'unknown'})`)
  }
  if (registered === 0) {
    throw new Error(`no room tool could be registered (${String(TOOLS.length)} refused); see the warnings above`)
  }

  // One injection seam per process: a duplicate context name throws in the host,
  // so the failure is reported and the module keeps working read-side.
  const context = registerRoomContext(svc, {
    get: name2 => deps.ctx.get(name2),
    effect: typeof deps.ctx.effect === 'function' ? (run, label) => deps.ctx.effect(run, label) : undefined,
  })
  if (context.ok) deps.log(`rooms: ${context.message}`)
  else deps.warn(`rooms: ${context.message}`)

  // Warm the ledger for whoever is already live, so a session that reopens after
  // a restart sees its unread mail on the FIRST turn instead of the second.
  for (const agent of svc.liveAgents()) {
    void svc.prime(agent.id).catch((error: unknown) => {
      deps.warn(`rooms: prime(${agent.id}) failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  deps.log(`rooms: ready (enabled=${String(svc.enabled)}, tools=${String(registered)}/${String(TOOLS.length)}, stateRoot=${svc.root})`)
}
