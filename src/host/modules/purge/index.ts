/**
 * Purge module — the one destructive, whole-state operation.
 *
 * `cortex_purge` permanently deletes EVERYTHING under the plugin's state root
 * (every memory, todo, room, job, log and pending proposal) by calling
 * `deps.store.purgeRoot()`. It is irreversible, so it is gated by a fixed
 * confirm literal the caller must type exactly — mirroring how the memory delete
 * tool gates a single entry, but at the whole-state scale. After the wipe the
 * root is re-created empty so the plugin keeps working this session.
 *
 * The tool never reads user text into a description and never throws; a wrong
 * confirm is a sentence (ok:false), not an exception.
 */
import { neutralize } from '../../../lib/sanitize.ts'
import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { refuse } from '../../rpc-error.ts'

/** The exact string the caller must type to confirm a full-state purge. */
export const PURGE_CONFIRM = 'PURGE_ALL_CORTEX_STATE'

/** Module id used by the wiring loop and reported by `cortex_status`. */
export const name = 'purge'

/** Tool ids owned by this module (reported through `cortex_status`). */
export const TOOLS = ['cortex_purge'] as const

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
      'Permanently delete ALL dsh-cortex state under the plugin state root — every memory, todo, room, delegation job, project log, prompt and pending proposal. This cannot be undone. It requires confirm to be the exact literal "PURGE_ALL_CORTEX_STATE"; any other value is refused and nothing is deleted. After the wipe the state root is re-created empty so the plugin stays usable.',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'string',
          description: 'Must be the literal "PURGE_ALL_CORTEX_STATE" typed exactly to confirm. Any other value is refused.',
        },
      },
      required: ['confirm'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>) => {
      const confirm = typeof args.confirm === 'string' ? args.confirm : ''
      if (confirm !== PURGE_CONFIRM) {
        return refuse(`cortex_purge refused: this permanently deletes ALL plugin state and requires confirm="${PURGE_CONFIRM}" typed exactly; nothing was deleted.`, 'bad-confirm')
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
  deps.log(`purge module wired (tools=${TOOLS.length}, needs confirm="${PURGE_CONFIRM}")`)
}
