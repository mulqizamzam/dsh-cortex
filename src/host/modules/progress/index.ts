/**
 * M3 · progress module face: `{ name, TOOLS, apply }`.
 *
 * No injection context and no RPC endpoints: a progress report is a thing a
 * human or the AI ASKS for, so it exists as one tool (`cortex_progress_report`,
 * DESIGN §4). The report is composed from stored facts only — see `report.ts`.
 */
import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { ProgressService } from './service.ts'
import { PROGRESS_BUDGET_CHARS } from './report.ts'

export const name = 'progress'
export const TOOLS = ['cortex_progress_report'] as const

export { ProgressService }
export {
  PROGRESS_BUDGET_CHARS, PROGRESS_ENTRY_LIMIT, PROGRESS_LOG_DAYS, collectProgress, progressHeader, renderProgress,
} from './report.ts'
export type { ProgressInput, ProgressResult, ProgressSource } from './report.ts'

let service: ProgressService | null = null

/** The live service after `apply` (tests, status reporting, integration). */
export function getProgressService(): ProgressService | null {
  return service
}

/** Contract parity with the other modules: this one exposes no endpoint maps. */
export const readEndpoints: Record<string, never> = {}
export const writeEndpoints: Record<string, never> = {}

export function apply(deps: ModuleDeps): void {
  const svc = new ProgressService({ deps })
  service = svc
  const registered = registerToolSafe(deps.ctx, svc.tool())
  if (!registered.ok) {
    // The module is exactly one tool; without it there is nothing to report.
    throw new Error(`progress: ${registered.name} registration refused (${registered.error ?? 'unknown'})`)
  }
  deps.log(`progress: ready (report ceiling ${String(PROGRESS_BUDGET_CHARS)} chars)`)
}
