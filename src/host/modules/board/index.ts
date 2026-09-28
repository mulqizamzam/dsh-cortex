/**
 * M-board module face: exports `{ name, TOOLS, apply, readEndpoints, writeEndpoints }`.
 *
 * What the module owns:
 *  - the seven `cortex_board_*` tools;
 *  - the `boards.*` RPC endpoint handlers.
 *
 * Gated on `board.enabled` in config (P3: OFF by default).
 */
import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { boardService, resetBoardService } from './service.ts'
import { bindBoardEndpoints } from './rpc.ts'
import { boardTools } from './tools.ts'

export { bindBoardEndpoints, readEndpoints, writeEndpoints } from './rpc.ts'
export { boardService, resetBoardService } from './service.ts'
export type { BoardService, BoardOutcome, CardOutcome, CommentOutcome } from './service.ts'

export const name = 'board'

export const TOOLS = [
  'cortex_board_create',
  'cortex_board_list',
  'cortex_board_get',
  'cortex_board_add',
  'cortex_board_move',
  'cortex_board_comment',
  'cortex_board_delete',
] as const

export function apply(deps: ModuleDeps): void {
  const svc = boardService(deps)
  // The RPC maps close over this registry, so they are only answerable once it
  // points at THIS service instance. Without this the seven tools work and
  // every `boards.*` call refuses with "not-wired" — two different paths, one
  // of which nobody was binding.
  bindBoardEndpoints(svc)
  let registered = 0
  for (const definition of boardTools(svc)) {
    const result = registerToolSafe(deps.ctx, definition)
    if (result.ok) registered += 1
    else deps.warn(`board: registration refused for ${result.name} (${result.error ?? 'unknown'})`)
  }
  if (registered === 0) {
    throw new Error(`no board tool could be registered (${TOOLS.length} refused)`)
  }
  deps.log(`board: ready (enabled=${String(svc.enabled)}, tools=${String(registered)}/${String(TOOLS.length)})`)
}
