/**
 * M-conflict: conflict detection module.
 *
 * Lightweight "heads up" for concurrent file writes in a room.
 * See {@link service.ts} for the full contract.
 */
import { registerLifecycle, registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { conflictTools, conflictService } from './service.ts'

export const name = 'conflict'

/** Tool ids this module owns. */
export const TOOLS = [
  'cortex_conflict_declare',
  'cortex_conflict_check',
  'cortex_conflict_release',
  'cortex_conflict_list',
] as const

export { conflictService, resetConflictService } from './service.ts'
export type { ConflictService, ConflictClaim, ConflictCheckResult } from './service.ts'

export function apply(deps: ModuleDeps): void {
  const svc = conflictService(deps)

  // Start periodic expiry cleanup.
  svc.startExpiryCleanup(60_000)

  // F10: release the instance on shutdown so a fresh boot gets a fresh service.
  registerLifecycle(deps.ctx, () => { svc.stopExpiryCleanup(); svc.clear() }, 'dsh-cortex:conflict service', deps.warn)

  let registered = 0
  for (const definition of conflictTools(svc)) {
    const result = registerToolSafe(deps.ctx, definition)
    if (result.ok) registered += 1
    else deps.warn(`conflict: registration refused for ${result.name} (${result.error ?? 'unknown'})`)
  }

  deps.log(`conflict: ready (tools=${String(registered)}/${String(TOOLS.length)})`)
}
