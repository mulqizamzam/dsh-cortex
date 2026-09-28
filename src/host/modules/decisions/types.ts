/**
 * Decision record types for the decisions module.
 *
 * The canonical `Decision` interface lives in `host/types.ts` (the shared data
 * contract). This file re-exports it so parser and module internals have a
 * short import path without duplicating the definition.
 */
export type { Decision } from '../../types.ts'
import type { Decision } from '../../types.ts'

export interface DecisionParseResult {
  ok: boolean
  decision?: Decision
  error?: string
}
