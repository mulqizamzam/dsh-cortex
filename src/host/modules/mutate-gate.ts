/**
 * I-02 mutation gate helper.
 *
 * Provides the shared token store and the wrapper that gates any destructive
 * mutation (delete / archive / update) behind a two-step confirm when
 * `mutate.confirmRequired = true`.
 *
 * Design decisions:
 * - Additive writes (todo_add, log_append, room_post, memory_remember) are
 *   NOT gated: they create or extend, never destroy. Gating them would block
 *   productive agent work with no safety gain.
 * - The gate is OFF by default (P3). Existing rooms and configs behave exactly
 *   as before until an operator opts in.
 * - When ON, the gate wraps the existing tool function: the first call returns a
 *   single-use token bound to the operation key; the second call must present it.
 *   The underlying logic is unchanged — the gate is purely additive.
 */
import { ConfirmTokens } from './memory/ops.ts'

/** Shared token store for all mutation-gated operations. */
export const mutateTokens = new ConfirmTokens()

/** The two-step envelope returned on step 1 of a gated mutation. */
export interface MutateGateResult {
  ok: boolean
  /** Step 1: single-use token to pass as `confirm` on the second call. */
  token?: string
  /** Step 1: human-readable warning naming what will happen. */
  warning?: string
  /** Step 2 success. */
  result?: unknown
}

/**
 * Gate a destructive tool call behind a two-step confirm when
 * `mutate.confirmRequired` is true.
 *
 * @param confirmRequired  the current config value (true = gate ON)
 * @param key              the operation key (e.g. "memory:archive:<id>")
 * @param confirmArg       the `confirm` argument from the tool call
 * @param describe         human-readable description of what will happen
 * @param fn               the actual mutation function to call on step 2
 */
export async function gateMutation<T>(
  confirmRequired: boolean,
  key: string,
  confirmArg: unknown,
  describe: string,
  fn: () => Promise<T>,
): Promise<MutateGateResult> {
  if (!confirmRequired) {
    return { ok: true, result: await fn() }
  }
  const confirm = typeof confirmArg === 'string' ? confirmArg.trim() : ''
  if (confirm === '') {
    // Step 1: name the operation, return a token, do nothing.
    const token = mutateTokens.issue(key)
    return { ok: true, token, warning: `About to ${describe}. Nothing has changed yet. Call again with confirm="${token}" to proceed; the token works once and expires after 5 minutes.` }
  }
  // Step 2: the only value that proceeds is the exact issued token.
  if (!mutateTokens.consume(confirm, key)) {
    return { ok: false, warning: `confirm "${confirm}" is not the single-use token issued for this operation. Tokens are single-use and expire after 5 minutes. Call without confirm to get a fresh one.` }
  }
  return { ok: true, result: await fn() }
}