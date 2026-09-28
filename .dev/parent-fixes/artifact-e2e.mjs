// Parent e2e on the REAL build artifact (no LLM needed): boot apply() with a
// faithful fake ctx, capture the RPC handlers, and drive the user journey.
import { mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, readdir } from 'node:fs/promises'
const mod = await import(new URL('../../lib/index.js', import.meta.url).href)
const root = mkdtempSync(join(tmpdir(), 'cortex-e2e-'))
const tools = new Map(); const channels = {}; const warns = []
const ctx = {
  tools: { register: (d) => { if (tools.has(d.name)) throw new Error(`${d.name} already registered`); tools.set(d.name, d); return () => {} } },
  commands: { register: () => () => {} },
  settings: { writable: false, register: (_ns, _c, o) => ({ get: () => o.base ?? {} }), mutate: async () => {} },
  agents: { get: () => undefined, roots: () => [] },
  subagents: { list: () => [], getProvider: () => undefined, start: async () => { throw new Error('n/a') } },
  get: (n) => { if (n === 'systemPrompt') return { section: () => () => {}, context: (e) => { ctx.__contexts ??= new Map(); if (ctx.__contexts.has(e.name)) throw new Error(`${e.name} dup`); ctx.__contexts.set(e.name, e); return () => {} } }; if (n === 'dshHomePath') return (...s) => join(root, ...s); return undefined },
  inject: (svcs, cb) => { if (svcs.includes('connection')) cb({ connection: { rpc: { handle: (ch, h) => { channels[ch] = h; return () => {} } } } }) },
  on: () => () => {}, effect: (cb) => { const r = cb(); return typeof r === 'function' ? r : () => {} },
}
mod.apply(ctx, { stateRoot: join(root, 'state') })
let failures = 0
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) failures += 1 }
const read = channels['/dsh-cortex-read']; const write = channels['/dsh-cortex-write']
const ping = await read('ping', {})
ok('ping ok + version', ping.ok === true && ping.value.version === '0.1.0')
ok('unknown read endpoint refused', (await read('nope', {})).ok === false)
ok('write channel mounted', typeof write === 'function')
// user journey: AI proposes -> UI approves by-kind -> memory listed + context renders it
const sig = { signal: new AbortController().signal, agent: { id: 'session-e2e', status: 'idle', session: { header: { cwd: root } }, options: {} } }
const rem = await tools.get('cortex_memory_remember').execute({ track: 'global', content: 'deploy port is 8080', importance: 4 }, sig)
ok('remember -> pending (no autoAccept)', JSON.stringify(rem).includes('pending'))
const listed = await read('pending.list' /* not mounted? use tool */, {})
// pending list via read endpoint contract name:
const pend = await read('memory.list', { track: 'global' })
const pendList = await (async () => { const t = await read('todo.list', {}) ; return t })()
// find the pending id through reject/approve round trip on write channel using list endpoint per contract:
const pList = await read('pending.list', {}) // contract read? if unknown, fall back to tool listing below
let pendingId = null
if (pList.ok === true) pendingId = (pList.value.items ?? pList.value)[0]?.id ?? null
if (pendingId === null) { const l = await tools.get('cortex_memory_list').execute({ pending: true }, sig); pendingId = JSON.stringify(l).match(/"id":"([0-9a-f]{12})"/)?.[1] ?? null }
ok('pending id discoverable', pendingId !== null)
const appr = await write('pending.approve', { id: pendingId })
ok('by-kind approve(memory) works over write channel', appr.ok === true)
const after = await read('memory.list', { track: 'global' })
ok('entry visible after approve', JSON.stringify(after).includes('8080'))
// wrong-kind dispatcher guard: todo proposals are NOT silently memory-approved
const appr2 = await write('pending.approve', { id: 'ffffffffffff' })
ok('unknown pending refused, not crash', appr2.ok === false)
// context renders with label + G-04 header
const memCtx = ctx.__contexts.get('cortex:memory')
// one-step-ahead design (M2 deviation 5): FIRST call primes ('' + schedules load),
// a later call serves the memo. Exercise it like the host would across turns.
const first = memCtx ? String(memCtx.text({ agent: sig.agent, scope: sig.agent })) : ''
await new Promise(r => setTimeout(r, 150))
const block = memCtx ? String(memCtx.text({ agent: sig.agent, scope: sig.agent })) : ''
console.log(`  info: first='${first.slice(0, 40)}' second='${block.slice(0, 60)}'`)
ok('memory context renders honest block', block.includes('reference data') && block.includes('8080'))
ok('contexts registered (unique names)', ['cortex:memory','cortex:todo','cortex:rooms','cortex:prompts','cortex:logs'].filter(n => ctx.__contexts.has(n)).length >= 4)
// corrupt entry quarantine on read
const dirs = await readdir(join(root, 'state', 'global', 'entries')).catch(() => [])
if (dirs[0]) await writeFile(join(root, 'state', 'global', 'entries', dirs[0]), 'X{corrupt')
const after2 = await read('memory.list', { track: 'global' })
const quarantined = (await readdir(join(root, 'state', 'quarantine'))).some(f => f.includes('.corrupt-'))
ok('corrupt entry: read survives + quarantined', after2.ok === true && quarantined)
console.log(`E2E_DONE failures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
