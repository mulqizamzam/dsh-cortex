import { snapshotJsonValue } from '/home/administrator/deepseek-harness/packages/core/session/src/json.ts'
import { apply, cortexRuntime } from '../../lib/index.js'

const ROOT = '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/state-audit'
const tools = new Map()
const ctx = {
  tools: { register: (d) => { if (tools.has(d.name)) throw new Error('dup'); tools.set(d.name, d); return () => {} } },
  settings: { writable: false, register: (ns, _s, cfg) => ({ get: () => ({ stateRoot: ROOT, ...cfg.base }) }) },
  agents: { get: () => undefined, roots: () => [] },
  get: (n) => (n === 'dshHomePath' ? (...s) => [ROOT, ...s].join('/') : undefined),
  inject: (svcs, cb) => { if (svcs.includes('connection')) { ctx.connection = { rpc: { handle: () => () => {} } } } cb(ctx) },
  on: () => () => {}, effect: () => () => {},
}
apply(ctx, { stateRoot: ROOT })
console.log('BOOT_MODULES:', cortexRuntime().modules.map(m => `${m.name}:${m.state}`).join(' '))

function leaks(v, path = '$', out = []) {
  if (v === undefined) { out.push(`${path}=undefined`); return out }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return out
  if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) out.push(`${path}=${v}`); return out }
  if (Array.isArray(v)) { v.forEach((x, i) => leaks(x, `${path}[${i}]`, out)); return out }
  if (typeof v === 'object') { for (const k of Reflect.ownKeys(v)) leaks(v[k], `${path}.${String(k)}`, out); return out }
  out.push(`${path}=${typeof v}`); return out
}
const READONLY = {
  cortex_status: {}, cortex_memory_list: {}, cortex_memory_search: { query: 'x' }, cortex_log_read: { scope: 'daily' },
  cortex_todo_list: {}, cortex_room_list: {}, cortex_room_read: { roomId: 'nope' }, cortex_room_status: { roomId: 'nope' },
  cortex_progress_report: {}, cortex_delegate_status: {}, cortex_delegate_logs: { jobId: 'nope' }, cortex_delegate_result: { jobId: 'nope' },
}
for (const [name, args] of Object.entries(READONLY)) {
  const def = tools.get(name)
  if (def === undefined) { console.log(`${name.padEnd(26)} NOT_REGISTERED`); continue }
  let verdict
  try {
    const value = await def.execute(args, { signal: new AbortController().signal })
    const accepted = snapshotJsonValue(value) !== undefined
    const renderOk = (() => { try { return snapshotJsonValue(def.output.render(args, value)) !== undefined } catch (e) { return `render_threw` } })()
    verdict = `${accepted ? 'PASS ' : 'FAIL '} leaks=${JSON.stringify(leaks(value))} render=${JSON.stringify(renderOk)}`
  } catch (error) { verdict = `THREW (${String(error.message).slice(0, 60)})` }
  console.log(`${name.padEnd(26)} ${verdict}`)
}
// causality isolation: same tool, runtime where EVERY module carries an error string
const statusDef = tools.get('cortex_status')
const patched = cortexRuntime()
const orig = patched.modules
Object.defineProperty(patched, 'modules', { value: orig.map(m => ({ ...m, error: 'forced' })), configurable: true, writable: true })
const v2 = await statusDef.execute({}, { signal: new AbortController().signal })
console.log('CAUSALITY all-modules-failed =>', snapshotJsonValue(v2) !== undefined ? 'PASS (no undefined)' : 'FAIL')
Object.defineProperty(patched, 'modules', { value: orig, configurable: true, writable: true })
