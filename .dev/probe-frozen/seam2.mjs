import { apply } from '../../lib/index.js'
const ROOT = '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/seam-state'
const registrations = new Map()
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
const runCtx = { agent: { session: { header: { cwd: process.cwd() } } } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const probe = () => [...registrations.keys()].map(n => { const t = registrations.get(n).text(runCtx); return `${n}=${t === '' ? 'ABSENT' : 'present'}` }).join('  ')
// warm up, waiting on REAL async render completion
let waited = 0
while (waited < 8000) { const s = probe(); if (!s.includes('memory=ABSENT')) break; await sleep(150); waited += 150 }
console.log(`WARMED after ${waited}ms ->`, probe())
console.log('--- now a real 31s idle gap (typical pause between human turns) ---')
await sleep(31000)
console.log('FIRST assembly after idle ->', probe())
await sleep(1200)
console.log('SECOND assembly same turn ->', probe())
