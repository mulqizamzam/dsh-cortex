import { snapshotJsonValue } from '/home/administrator/deepseek-harness/packages/core/session/src/json.ts'
import { neutralizeDeep, neutralize } from '../../src/lib/sanitize.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import * as statusModule from '../../src/host/modules/status/index.ts'

const cfg = resolveConfig({})
const store = new CortexStore({ root: '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/nonexistent-root', caps: () => cfg.caps, warn: () => {} })
let captured = null
const ctx = { tools: { register(def) { captured = def } }, settings: {}, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, inject: () => {}, on: () => () => {}, effect: () => () => {} }
const MODULES = [
  { name: 'status', state: 'ok', tools: ['cortex_status'] },
  { name: 'memory', state: 'failed', error: 'boom {{x}}', tools: ['x'] },
  { name: 'skippedmod', state: 'skipped', tools: [] },
]
const runtime = () => ({ modules: MODULES, errors: [] })
statusModule.apply({ ctx, cfg: () => cfg, store, log: () => {}, warn: () => {}, runtime })
const base = await captured.execute({}, { signal: new AbortController().signal })

function leaks(v, path = '$', out = []) {
  if (v === undefined) { out.push([path, 'undefined']); return out }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return out
  if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) out.push([path, String(v)]); return out }
  if (Array.isArray(v)) { v.forEach((x, i) => leaks(x, `${path}[${i}]`, out)); return out }
  if (typeof v === 'object') { for (const k of Reflect.ownKeys(v)) leaks(v[k], `${path}.${String(k)}`, out); return out }
  out.push([path, typeof v]); return out
}
const mapMods = {
  null: mods => mods.map(i => ({ ...i, error: i.error === undefined ? null : neutralize(i.error) })),
  omit: mods => mods.map(i => (i.error === undefined ? { ...i } : { ...i, error: neutralize(i.error) })),
}
for (const [label, fn] of Object.entries(mapMods)) {
  const payload = neutralizeDeep({ ...base, modules: fn(MODULES) })
  const accepted = snapshotJsonValue(payload) !== undefined
  console.log(`FIX[${label}] snapshot=${accepted ? 'ACCEPTED' : 'REJECTED'} remaining_leaks=${JSON.stringify(leaks(payload))} failed_err=${JSON.stringify(payload.modules[1].error)} ok_keys=${Object.keys(payload.modules[0]).join(',')} skipped_err=${JSON.stringify(payload.modules[2].error)}`)
}
// render() edge: what the model actually sees must stay valid too
console.log('RENDERS_NULL:', JSON.stringify(snapshotJsonValue(base.output.render({}, neutralizeDeep({ ...base, modules: mapMods.null(MODULES) }))) !== undefined))
console.log('RENDERS_OMIT:', JSON.stringify(snapshotJsonValue(base.output.render({}, neutralizeDeep({ ...base, modules: mapMods.omit(MODULES) }))) !== undefined))
// does render text differ between variants? (proves which is observable to the model)
console.log('NULL_TEXT_HAS_ERROR_NULL:', /"error": null/.test(base.output.render({}, neutralizeDeep({ ...base, modules: mapMods.null(MODULES) }))[0].text))
console.log('OMIT_TEXT_HAS_ERROR_NULL:', /"error": null/.test(base.output.render({}, neutralizeDeep({ ...base, modules: mapMods.omit(MODULES) }))[0].text))
