/**
 * Purge module — the one destructive, whole-state operation.
 *
 * `cortex_purge` permanently deletes EVERYTHING under the plugin's state root
 * (every memory, todo, room, job, log and pending proposal) by calling
 * `deps.store.purgeRoot()`. It is irreversible, so it is ALWAYS two steps
 * (D-03): the first call names the operation and returns a single-use token; the
 * second presents that token. The wipe happens ONLY when the second call
 * presents the exact token the first call issued — a guess, the old frozen
 * literal (`PURGE_ALL_CORTEX_STATE`), an empty string, or a reused or expired
 * token are all refused and delete nothing.
 *
 * This mirrors the memory-delete two-step exactly (same `ConfirmTokens`
 * mechanism, same 5-minute TTL), so one learnable contract covers both
 * irreversible tools. The literal `PURGE_ALL_CORTEX_STATE` is RETIRED: it is a
 * fixed string any model can emit, which made "confirmed" mean nothing.
 *
 * The tool never reads user text into a description and never throws; a bad
 * confirm is a sentence (ok:false), not an exception.
 */
import { neutralize } from '../../../lib/sanitize.ts'
import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { refuse } from '../../rpc-error.ts'
import { ConfirmTokens } from '../memory/ops.ts'

/** The confirm-token key every purge token is bound to (the whole state root). */
export const PURGE_TOKEN_KEY = 'purge:all'

/**
 * RETIRED literal. Exported so docs and tests can assert the old contract is
 * gone; it is never accepted as a confirm value.
 */
export const PURGE_CONFIRM = 'PURGE_ALL_CORTEX_STATE'

/** Module id used by the wiring loop and reported by `cortex_status`. */
export const name = 'purge'

/** Tool ids owned by this module (reported through `cortex_status`). */
export const TOOLS = ['cortex_purge'] as const

/** Token store for this module; single-use, 5-minute TTL. */
const tokens = new ConfirmTokens()

/** Output renderer: prose when there is prose, JSON otherwise. */
function renderValue(_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> {
  const record = value as unknown as Record<string, unknown>
  if (typeof record === 'object' && record !== null && typeof record.text === 'string') return text(record.text)
  return text(value)
}

/** The single tool this module registers. */
export function buildTools(deps: ModuleDeps): ToolDefinition[] {
  const purgeTool = defineTool({
    name: 'cortex_purge',
    description:
      'Permanently delete ALL dsh-cortex state under the plugin state root — every memory, todo, room, delegation job, project log, prompt and pending proposal. This cannot be undone, so it is always two steps: call once with no confirm to receive a single-use token (valid 5 minutes), then call again with that token as confirm to perform the wipe. A guess, the retired PURGE_ALL_CORTEX_STATE literal, an empty value, or a reused token is refused and nothing is deleted. After the wipe the state root is re-created empty so the plugin stays usable.',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'string',
          description: 'Step 2 only: the single-use token returned by the first call. Omit or leave empty for step 1 (get a token).',
        },
      },
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>) => {
      const confirm = typeof args.confirm === 'string' ? args.confirm.trim() : ''
      if (confirm === '') {
        // Step 1: name the operation, hand back a single-use token, delete nothing.
        const token = tokens.issue(PURGE_TOKEN_KEY)
        const warning = `About to permanently delete EVERY dsh-cortex entry under ${deps.store.root} — all memories, todos, rooms, jobs, logs, prompts and pending proposals, in every project. Nothing has been deleted yet. Call again with confirm="${token}" to do it; the token works once and expires after 5 minutes.`
        return { ok: true, deleted: false, token, text: neutralize(warning) }
      }
      // Step 2: the ONLY value that wipes is the exact issued token. The retired
      // literal, a guess, or a reused token all fail here.
      if (!tokens.consume(confirm, PURGE_TOKEN_KEY)) {
        return refuse('cortex_purge refused: confirm is not the single-use token issued for this purge. Tokens are single-use and expire after 5 minutes; the old fixed literal is no longer accepted. Nothing was deleted. Call with no confirm to get a fresh token.', 'bad-confirm')
      }
      const purged = await deps.store.purgeRoot()
      if (!purged.ok) {
        return refuse(neutralize(purged.error), 'purge-failed')
      }
      // Re-scaffold so the plugin is usable again immediately (the store root is
      // now recreateable from its own path).
      const reinit = await deps.store.init()
      if (!reinit.ok) deps.warn(`cortex_purge: state wiped but re-init failed: ${neutralize(reinit.error)}`)
      return {
        ok: true,
        deleted: true,
        removed: deps.store.root,
        reinit: reinit.ok === true,
        text: `All dsh-cortex state under ${deps.store.root} was permanently deleted and the state root was re-created empty.`,
      }
    },
  } as never)
  return [purgeTool]
}

/** Wire the module: register the tool, report a refused name instead of crashing. */
export function apply(deps: ModuleDeps): void {
  const refused: string[] = []
  for (const definition of buildTools(deps)) {
    const result = registerToolSafe(deps.ctx, definition)
    if (!result.ok) refused.push(`${result.name}: ${result.error ?? 'refused'}`)
  }
  if (refused.length > 0) {
    deps.warn(`purge: registration refused: ${refused.join('; ')}`)
    throw new Error(`purge tool registration refused: ${refused.join('; ')}`)
  }
  deps.log(`purge module wired (tools=${TOOLS.length}, two-step confirm token)`)
}
