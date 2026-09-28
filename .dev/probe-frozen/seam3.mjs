// INVESTIGATION ONLY — no production file touched. Varies cache age + agent presence.
import { apply } from '../../lib/index.js'
const ROOT = '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex/.dev/probe-frozen/seam3-state'
const reg = new Map()
const ctx = {
  tools: { register: () => () => {} },
  settings: { writable: false, register: (ns, _s, cfg) => ({ get: () => ({ stateRoot: ROOT, ...cfg.base }) }) },
  agents: { get: () => undefined, roots: () => [] },
  get: (n) => n === 'systemPrompt' ? { context: (e) => { reg.set(e.name, e); return () => {} } } : (n === 'dshHomePath' ? (...s) => [ROOT, ...s].join('/') : undefined),
  inject: (svcs, cb) => { if (svcs.includes('connection')) ctx.connection = { rpc: { handle: () => () => {} } }; cb(ctx) },
  on: () => () => {}, effect: () => () => {},
}
apply(ctx, { stateRoot: ROOT })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const probe = (runCtx) => ['cortex:memory', 'cortex:todo'].map(n => { const t = reg.get(n).text(runCtx); return `${n.replace('cortex:', '')}=${t === '' ? 'ABSENT' : 'present'}` }).join(' ')
const warm = async (runCtx) => { for (let i = 0; i < 60; i++) { if (!probe(runCtx).includes('ABSENT')) return i * 150; await sleep(150) } return -1 }
const HOME = process.cwd(), ELSEWHERE = '/home/administrator/deepseek-harness'

console.log('A. agent present, cwd seen before   ->', probe({ agent: { session: { header: { cwd: HOME } } } }))
console.log('B. assemble with NO agent at all    ->', probe({}))
console.log('C. agent without session.header.cwd ->', probe({ agent: {} }))
console.log('D. FIRST assembly, never-seen cwd   ->', probe({ agent: { session: { header: { cwd: ELSEWHERE } } } }))
await sleep(900)
console.log('   same turn, after render          ->', probe({ agent: { session: { header: { cwd: ELSEWHERE } } } }))
console.log('E. back to original cwd             ->', probe({ agent: { session: { header: { cwd: HOME } } } }))
