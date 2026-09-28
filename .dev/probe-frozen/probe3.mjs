import { snapshotJsonValue } from '/home/administrator/deepseek-harness/packages/core/session/src/json.ts'
import { neutralizeDeep, neutralize } from '../../src/lib/sanitize.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import * as statusModule from '../../src/host/modules/status/index.ts'
const cfg = resolveConfig({})
const store = new CortexStore({ root: '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/nope', caps: () => cfg.caps, warn: () => {} })
let def = null
const ctx = { tools: { register(d) { def = d } }, settings: {}, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, inject: () => {}, on: () => () => {}, effect: () => () => {} }
const MODULES = [{ name: 'status', state: 'ok', tools: ['cortex_status'] }, { name: 'memory', state: 'failed', error: 'boom {{x}}', tools: ['x'] }]
statusModule.apply({ ctx, cfg: () => cfg, store, log: () => {}, warn: () => {}, runtime: () => ({ modules: MODULES, errors: [] }) })
const base = await def.execute({}, { signal: new AbortController().signal })
const variants = {
  null: neutralizeDeep({ ...base, modules: MODULES.map(i => ({ ...i, error: i.error === undefined ? null : neutralize(i.error) })) }),
  omit: neutralizeDeep({ ...base, modules: MODULES.map(i => (i.error === undefined ? { ...i } : { ...i, error: neutralize(i.error) })) }),
}
for (const [label, payload] of Object.entries(variants)) {
  const blocks = def.output.render({}, payload)
  const snap = snapshotJsonValue(blocks)
  console.log(`RENDER[${label}] snapshot=${snap === undefined ? 'REJECTED' : 'ACCEPTED'} block_shape_ok=${Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text'}`)
  console.log(`  error_line_rendered_as: ${blocks[0].text.split('\n').filter(l => /"error"/.test(l)).map(s => s.trim()).join(' | ')}`)
}
// schema check: does the declared output schema constrain error's type?
console.log('OUTPUT_SCHEMA:', JSON.stringify(def.output.schema), '| params:', JSON.stringify(def.parameters))
