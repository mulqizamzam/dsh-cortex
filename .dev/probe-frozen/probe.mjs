// READ-ONLY PROBE. Touches no plugin source, no profile config, no state root.
import { snapshotJsonValue } from '/home/administrator/deepseek-harness/packages/core/session/src/json.ts'
import { neutralizeDeep, neutralize } from '../../src/lib/sanitize.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import * as statusModule from '../../src/host/modules/status/index.ts'

const cfg = resolveConfig({})
const store = new CortexStore({ root: '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/nonexistent-root', caps: () => cfg.caps, warn: () => {} })

// Fake host ctx: capture the tool definition exactly as apply() registers it.
let captured = null
const ctx = { tools: { register(def) { captured = def } }, settings: {}, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, inject: () => {}, on: () => () => {}, effect: () => () => {} }
const runtime = () => ({
  modules: [
    { name: 'status', state: 'ok', tools: ['cortex_status'] },                 // no error field at all
    { name: 'memory', state: 'failed', error: 'boom {{x}}', tools: ['x'] },    // error present
  ],
  errors: ['module:memory boom {{y}}'],
})
statusModule.apply({ ctx, cfg: () => cfg, store, log: () => {}, warn: () => {}, runtime })

const value = await captured.execute({}, { signal: new AbortController().signal })

// --- 1. does the REAL host boundary accept it? ---
const detached = snapshotJsonValue(value)
console.log('SNAPSHOT_RESULT:', detached === undefined ? 'REJECTED (this is the live failure)' : 'ACCEPTED')

// --- 2. every path that leaks a non-JSON value ---
function leaks(v, path = '$', out = []) {
  if (v === undefined) { out.push([path, 'undefined']); return out }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return out
  if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) out.push([path, 'non-finite/neg-zero ' + v]); return out }
  if (Array.isArray(v)) { v.forEach((x, i) => leaks(x, `${path}[${i}]`, out)); return out }
  if (typeof v === 'object') { for (const k of Reflect.ownKeys(v)) leaks(v[k], `${path}.${String(k)}`, out); return out }
  out.push([path, 'non-object ' + typeof v]); return out
}
console.log('LEAK_PATHS:', JSON.stringify(leaks(value), null, 0))
console.log('HAS_OWN_ERROR_KEY_ON_OK_MODULE:', Object.prototype.hasOwnProperty.call(value.modules[0], 'error'), '| its value:', String(value.modules[0].error))
console.log('FAILED_MODULE_ERROR:', JSON.stringify(value.modules[1].error))
console.log('JSON_STRINGIFY_DROPS_IT:', JSON.stringify(value.modules[0]))

// --- 3. candidate fixes, both cross the same real boundary? ---
const variants = {
  'null': view => view.modules.map(i => ({ ...i, error: i.error === undefined ? null : neutralize(i.error) })),
  'omit': view => view.modules.map(i => (i.error === undefined ? { ...i } : { ...i, error: neutralize(i.error) })),
}
for (const [label, mapMods] of Object.entries(variants)) {
  const payload = neutralizeDeep({ ...value, modules: mapMods(runtime().modules) })
  const okFix = snapshotJsonValue(payload) !== undefined
  const remainingLeaks = leaks(payload)
  console.log(`FIX[${label}] snapshot=${okFix ? 'ACCEPTED' : 'REJECTED'} leaks=${remainingLeaks.length} neutralize_kept=${JSON.stringify(payload.modules[1].error)} ok_module=${JSON.stringify(payload.modules[0])}`)
}
