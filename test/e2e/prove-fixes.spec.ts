/**
 * E2E proof: each fixed defect is closed at the boundary a real session uses.
 *
 * The unit-level regression tests call internal APIs directly
 * (`new DelegateService(deps)`, `store.logAppend`, `svc.indexLogLines`). They
 * pin the mechanism, but they cannot show that the TOOL a session actually
 * calls behaves correctly — different parameter surface, different defaults,
 * different return shape. This file goes through the real entry point:
 *
 *   1. a host context with the services `apply()` injects
 *   2. `apply(ctx, config)` — exactly what the host calls on boot
 *   3. `ctx.tools.get(name).execute(args, {signal})` — the real tool contract
 *
 * One `apply()` per file, on purpose: `todo`, `logs`, `delegate` and `decisions`
 * expose no service reset, so a second apply would reuse singletons bound to the
 * previous state root. Each case below uses its own resource instead.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/host/index.ts'
import { getDelegateService } from '../../src/host/modules/delegate/index.ts'
import { DEFAULT_CONFIG } from '../../src/host/config.ts'
import { isoDate } from '../../src/lib/ids.ts'
import type { CortexStore } from '../../src/host/store.ts'
import type { ToolDefinition } from '../../src/host/dsh.ts'

const SLEEP = fileURLToPath(new URL('../delegate/fixtures/sleep-runner.mjs', import.meta.url))

/** Small log caps so the rollover limit is reachable inside a test. */
const CAPS = { logLineChars: 24, logDayChars: 8 }

let root = ''
let tools: Map<string, ToolDefinition>
let pluginStore: CortexStore
/** Channel name -> handler, exactly as `connection.rpc.handle` receives them. */
const rpcHandlers = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-e2e-'))
  tools = new Map<string, ToolDefinition>()
  const liveAgents = Array.from({ length: 20 }, (_, index) => ({
    id: `s-${String(index)}`,
    status: 'idle',
    options: {},
    session: { header: {} },
  }))
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
      get: (name: string) => tools.get(name),
    },
    // `cortex_room_join` refuses a sessionId the host does not report as live
    // (rooms/tools.ts), so enrolling members needs a host that has them.
    agents: {
      get: (id: string) => liveAgents.find(agent => agent.id === id),
      roots: () => liveAgents,
    },
    get(name: string) {
      if (name === 'dshHomePath') return (...segments: string[]) => join(root, ...segments)
      return undefined
    },
    inject: (services: string[], callback: (context: unknown) => void) => {
      if (services.includes('connection')) {
        (ctx as { connection?: unknown }).connection = {
          rpc: {
            handle(channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>): () => void {
              rpcHandlers.set(channel, handler)
              return () => { rpcHandlers.delete(channel) }
            },
          },
        }
      }
      callback(ctx)
    },
    on: () => () => {},
    effect: (callback: () => unknown) => { callback(); return () => {} },
  } as never

  apply(ctx, {
    stateRoot: root,
    caps: CAPS,
    delegation: {
      ...DEFAULT_CONFIG.delegation,
      enabled: true,
      maxConcurrent: 2,
      runners: {
        quick: { argv: ['/bin/true'], description: 'exits at once', timeoutSec: 0, env: {} },
        sleepy: { argv: [process.execPath, SLEEP, '30000'], description: 'sleeps', timeoutSec: 0, env: {} },
      },
    },
  } as never)

  const svc = getDelegateService()
  if (svc === null) throw new Error('delegate service was not bound by apply()')
  pluginStore = (svc as unknown as { deps: { store: CortexStore } }).deps.store
  await pluginStore.init()
})

afterAll(async () => {
  const svc = getDelegateService()
  if (svc !== null) for (const id of svc.activeIds()) await svc.cancel(id).catch(() => {})
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

async function runTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return await tool.execute(args as never, { signal: new AbortController().signal }) as Record<string, unknown>
}

describe('E2E through the real tool surface', () => {
  it('cortex_todo_add x20 concurrent: every add is stored', async () => {
    const adds = await Promise.all(
      Array.from({ length: 20 }, (_, index) => runTool('cortex_todo_add', { track: 'work', text: `e2e todo ${String(index)}` })),
    )
    const added = adds.filter(result => result.status === 'added').length
    const listed = await runTool('cortex_todo_list', { tracks: ['work'], openOnly: true })
    console.log(`E2E TODOS added=${String(added)}/20 listed.count=${String(listed.count)}`)
    expect(added).toBe(20)
    expect(listed.count).toBe(20)
  })

  it('cortex_log_append refuses a line the rollover limit could not place', async () => {
    const day = isoDate(new Date())
    const dir = join(root, 'daily')
    await mkdir(dir, { recursive: true })
    // The rollover names parts -2.md .. -49.md, and part -50.md is the last
    // candidate. Fill the day file and -2..-49 so that last candidate is all
    // that is left; an off-by-one here silently tests the happy path instead.
    const full = 'x'.repeat(50)
    await writeFile(join(dir, `${day}.md`), full, 'utf8')
    for (let index = 2; index <= 49; index += 1) {
      await writeFile(join(dir, `${day}-${String(index)}.md`), full, 'utf8')
    }
    const appended = await runTool('cortex_log_append', { scope: 'daily', text: 'AUDIT-LINE' })
    console.log(`E2E LOG status=${String(appended.status)} message=${String(appended.message).slice(0, 70)}`)
    expect(appended.status).toBe('refused')
  })

  it('cortex_delegate holds maxConcurrent when dispatches overlap', async () => {
    let reads = 0
    let releaseAll: (() => void) | undefined
    const allArrived = new Promise<void>(resolve => { releaseAll = resolve })
    const timer = setTimeout(() => releaseAll?.(), 200)
    const real = pluginStore.listJobs.bind(pluginStore)
    ;(pluginStore as unknown as { listJobs: typeof pluginStore.listJobs }).listJobs = async () => {
      reads += 1
      if (reads >= 3) releaseAll?.()
      await allArrived
      return await real()
    }
    let dispatched = 0
    try {
      const settled = await Promise.all(
        Array.from({ length: 3 }, () => runTool('cortex_delegate', { runner: 'sleepy', task: 'capacity probe' })),
      )
      dispatched = settled.filter(result => result.status === 'dispatched').length
    } finally {
      clearTimeout(timer)
      ;(pluginStore as unknown as { listJobs: typeof pluginStore.listJobs }).listJobs = real
      const svc = getDelegateService()
      if (svc !== null) for (const id of svc.activeIds()) await svc.cancel(id).catch(() => {})
    }
    console.log(`E2E CAPACITY dispatched=${String(dispatched)} of 3, cap=2`)
    expect(dispatched).toBeLessThanOrEqual(2)
  })

  it('cortex_decision_index_logs reads every documented marker form', async () => {
    const day = isoDate(new Date())
    await writeFile(join(root, 'daily', `${day}.md`), [
      '- [decision] ctx dash | chosen: a | rationale: r1',
      '* [decision] ctx star | chosen: b | rationale: r2',
      '> [decision] ctx quote | chosen: c | rationale: r3',
      '  - [decision] ctx indent | chosen: d | rationale: r4',
    ].join('\n'), 'utf8')
    const indexed = await runTool('cortex_decision_index_logs', { scope: 'daily' })
    console.log(`E2E MARKERS indexed=${String(indexed.indexed)} errors=${JSON.stringify(indexed.errors ?? [])}`)
    expect(indexed.indexed).toBe(4)
  })

  it('cortex_conflict_declare judges an old claim by ITS ttl, not the new one', async () => {
    const path = join(root, 'projects', 'p1', 'main.ts')
    await runTool('cortex_conflict_declare', { roomId: 'room-ttl', path, sessionId: 'session-1', ttlSeconds: 10 })

    // An hour later — past the claim's own 10 s ttl — a declaration carrying no
    // ttl of its own (the default) must not see a conflict.
    const realNow = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 3_600_000)
    let conflicts: unknown[] = []
    try {
      const second = await runTool('cortex_conflict_declare', { roomId: 'room-ttl', path, sessionId: 'session-2' })
      conflicts = (second.conflicts as unknown[]) ?? []
    } finally {
      spy.mockRestore()
    }
    console.log(`E2E CONFLICT conflictsOnExpiredClaim=${String(conflicts.length)}`)
    expect(conflicts).toHaveLength(0)
  })

  it('cortex_room_post recovers a lost seq above the newest stored message', async () => {
    const created = await runTool('cortex_room_create', { title: 'seq room' })
    const roomId = String(created.roomId ?? '')
    expect(roomId).not.toBe('')
    const dir = pluginStore.paths.roomMessages(roomId)
    await mkdir(dir, { recursive: true })
    const highest = 2001
    for (let seq = 1; seq <= highest; seq += 1) {
      const name = `${String(seq).padStart(6, '0')}.json`
      await writeFile(join(dir, name), JSON.stringify({ seq, roomId, text: `ORIGINAL-${String(seq)}`, fromKind: 'session', images: [], at: 'x' }), 'utf8')
    }
    await rm(pluginStore.paths.roomSeq(roomId), { force: true })

    const posted = await runTool('cortex_room_post', { roomId, text: 'NEW MESSAGE' })
    const survivor = JSON.parse(await readFile(join(dir, `${String(highest).padStart(6, '0')}.json`), 'utf8')) as { text: string }
    console.log(`E2E SEQ assigned=${JSON.stringify(posted.seq)} expected=${String(highest + 1)} survivor=${survivor.text}`)
    expect(posted.seq).toBe(highest + 1)
    expect(survivor.text).toBe(`ORIGINAL-${String(highest)}`)
  })

  it('rooms.leave removes every member when leaves overlap (panel RPC path)', async () => {
    const channel = rpcHandlers.get('/dsh-cortex-write')
    expect(channel, 'the write channel must be registered by apply()').toBeDefined()
    const created = await runTool('cortex_room_create', { title: 'leave room' })
    const roomId = String(created.roomId ?? '')
    expect(roomId).not.toBe('')
    const count = 20
    for (let index = 0; index < count; index += 1) {
      await runTool('cortex_room_join', { roomId, sessionId: `s-${String(index)}`, label: `m${String(index)}` })
    }
    const before = await pluginStore.getRoom(roomId)
    expect(before.data?.members).toHaveLength(count)

    const leaves = await Promise.all(
      Array.from({ length: count }, (_, index) => channel?.('rooms.leave', { roomId, sessionId: `s-${String(index)}` })),
    )
    const okLeaves = leaves.filter(entry => (entry as { ok?: boolean } | undefined)?.ok === true).length
    const after = await pluginStore.getRoom(roomId)
    console.log(`E2E LEAVE ok=${String(okLeaves)}/${String(count)} membersLeft=${String(after.data?.members.length)}`)
    expect(okLeaves).toBe(count)
    expect(after.data?.members).toHaveLength(0)
  })
})
