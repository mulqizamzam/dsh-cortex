// Live-bundle seam probe: captures the real systemPrompt.context registrations.
import { apply } from '../../lib/index.js'
const ROOT = '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/seam-state'
const registrations = new Map()
let fakeNow = 1_700_000_000_000
const realNow = Date.now
Date.now = () => fakeNow
const tools = new Map()
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
  settings: { writable: false, register: (ns, _s, cfg) => ({ get: () => ({ stateRoot: ROOT, ...cfg.base }) }) },
  agents: { get: () => undefined, roots: () => [] },
  get: (n) => {
    if (n === 'systemPrompt') return { context: (e) => { registrations.set(e.name, e); return () => {} } }
    if (n === 'dshHomePath') return (...s) => [ROOT, ...s].join('/')
    return undefined
  },
  inject: (svcs, cb) => { if (svcs.includes('connection')) ctx.connection = { rpc: { handle: () => () => {} } }; cb(ctx) },
  on: () => () => {}, effect: () => () => {},
}
apply(ctx, { stateRoot: ROOT })
console.log('SEAM REGISTRATIONS:', [...registrations.entries()].map(([n, e]) => `${n}@order${e.order}`).join('  '))
const runCtx = { agent: { session: { header: { cwd: process.cwd() } } } }
const settle = async () => { for (let i = 0; i < 40; i++) { await new Promise(r => setImmediate(r)); await Promise.resolve() } }
const probe = () => [...registrations.entries()].map(([n, e]) => { const t = e.text(runCtx); return `${n}=${t === '' ? 'ABSENT' : `present(${t.length}ch)`}` }).join('  ')
await settle()
console.log('t=0    (after warm)      ', probe())
fakeNow = realNow.call(Date) + 46_000   // simulate a 46s idle gap between human turns
console.log('t=+46s (idle human turn)', probe())
await settle()
console.log('t=+46s again, same turn ', probe())
Date.now = realNow
