import { createMemoryInjector } from '../../src/host/modules/memory/runtime.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
const ROOT = '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/inj-state'
const cfg = resolveConfig({})
const store = new CortexStore({ root: ROOT, caps: () => cfg.caps, warn: () => {} })
await store.init()
let clock = 1_000_000
const now = () => clock
const deps = { ctx: { agents: { get: () => undefined } }, cfg: () => cfg, store, log: () => {}, warn: (m) => console.log('  warn:', m), runtime: () => ({ modules: [], errors: [] }) }
const inj = createMemoryInjector(deps, { now })
const ctx = { agent: { session: { header: { cwd: process.cwd() } } } }
const label = (t) => t === '' ? "''  (NO CORTEX MEMORY BLOCK)" : `block (${t.length} chars, first line: ${JSON.stringify(t.split('\n')[0].slice(0, 52))})`
const settle = async () => { for (let i = 0; i < 25; i++) { await new Promise(r => setImmediate(r)); await Promise.resolve() } }
console.log('CALL1 cold cache          ->', label(inj.text(ctx)));  await settle()
console.log('CALL2 after async render   ->', label(inj.text(ctx)))
clock += 6_000
console.log('CALL3 t+6s  (within TTL)   ->', label(inj.text(ctx))); await settle()
clock += 40_000
console.log('CALL4 t+46s (idle turn)    ->', label(inj.text(ctx))); await settle()
console.log('CALL5 same turn, post-render->', label(inj.text(ctx)))
