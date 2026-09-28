import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'

/**
 * Stub module that proves the M0 wiring end-to-end: one read-only tool
 * reporting module states, the effective config, and where state lives.
 * "scope: self" from the brief = this tool reports on the plugin itself;
 * a DSH ToolDefinition has no scope field (registration scope comes from the
 * calling context), so it is registered from the plugin root.
 */
export const name = 'status'
export const TOOLS = ['cortex_status'] as const

export function apply(deps: ModuleDeps): void {
  const { ctx, cfg, store, log, runtime } = deps
  const result = registerToolSafe(ctx, defineTool({
    name: 'cortex_status',
    description: 'Report dsh-cortex health: module states, effective config, and state paths. Read-only, no arguments. Call it before other cortex_* tools to confirm what loaded.',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: Record<string, unknown>, value: never) => text(value) },
    execute: async () => {
      const config = cfg()
      const view = runtime()
      log('cortex_status requested')
      // Final belt: deep-walk the whole payload so nested user-authored strings
      // (state.stateRoot, config.stateRoot, future snapshot fields) can never
      // smuggle a pair even if a new field forgets the per-field neutralize.
      return neutralizeDeep({
        plugin: 'dsh-cortex',
        version: '0.1.0',
        // #53: these strings can carry user-authored text (a configured
        // stateRoot, a filesystem message naming a user file), and tool output
        // IS model-visible, so the render edge neutralizes.
        bootError: view.bootError === undefined ? null : neutralize(view.bootError),
        wiringErrors: (view.errors ?? []).map(entry => neutralize(entry)),
        // `null`, never `undefined`: the host snapshots tool output through
        // snapshotJsonValue() and a present-but-undefined property is rejected as
        // "value is not lossless JSON" — invisible to JSON.stringify, which drops
        // the key. Same convention as `bootError` above.
        modules: view.modules.map(item => ({ ...item, error: item.error === undefined ? null : neutralize(item.error) })),
        stateRoot: neutralize(store.root),
        state: (await store.statusSnapshot()).data ?? { unavailable: true },
        config: {
          stateRoot: config.stateRoot === '' ? '(default: <DSH_HOME>/dsh-cortex)' : config.stateRoot,
          inject: config.inject,
          memory: config.memory,
          pending: config.pending,
          rooms: config.rooms,
          prompts: config.prompts,
          delegation: { enabled: config.delegation.enabled, runners: Object.keys(config.delegation.runners) },
          caps: config.caps,
          retention: config.retention,
        },
      })
    },
  } as never))
  if (!result.ok) throw new Error(`cortex_status registration refused: ${result.error ?? 'unknown'}`)
}
