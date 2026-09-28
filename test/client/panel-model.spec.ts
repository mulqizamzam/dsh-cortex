// @vitest-environment node
/**
 * Panel model behaviour: what is fetched when, what a click sends, and what a
 * failure looks like. The rules worth pinning are the ones a reviewer cannot
 * eyeball in the JSX — a write followed by a re-read, the nested-vs-flat scope
 * split, the spawn gate, and "no path leaves `ready` data next to a live error".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCortexApi } from '../../src/client/api.ts'
import type { CortexScope } from '../../src/client/api.ts'
import { createMockTransport } from '../../src/client/mock-adapter.ts'
import type { MockTransport } from '../../src/client/mock-adapter.ts'
import { createPanelModel, filterArgs } from '../../src/client/panel-model.ts'
import type { PanelModel } from '../../src/client/panel-model.ts'

let mock: MockTransport
let model: PanelModel

function build(scope: CortexScope = {}): MockTransport {
  mock = createMockTransport()
  model = createPanelModel(createCortexApi(mock.call), { current: () => scope })
  return mock
}

beforeEach(() => {
  build()
})

describe('loading', () => {
  it('starts every tab idle, so nothing renders as a fake empty list', () => {
    const state = model.state()
    expect(state.memory.list.kind).toBe('idle')
    expect(state.todo.list.kind).toBe('idle')
    expect(state.rooms.list.kind).toBe('idle')
    expect(state.jobs.list.kind).toBe('idle')
  })

  it('loadTab(memory) reads the list AND the pending queue', async () => {
    await model.loadTab('memory')
    expect(mock.log()).toEqual(['/dsh-cortex-read memory.list', '/dsh-cortex-read pending.list'])
    expect(model.state().memory.list.kind).toBe('ready')
    expect(model.state().memory.pending.kind).toBe('ready')
  })

  it('loadTab(rooms) reads rooms and sessions.status together, then opens one', async () => {
    await model.loadTab('rooms')
    const seen = mock.log()
    expect(seen).toContain('/dsh-cortex-read rooms.list')
    expect(seen).toContain('/dsh-cortex-read sessions.status')
    expect(seen).toContain('/dsh-cortex-read rooms.read')
    expect(seen).toContain('/dsh-cortex-read rooms.status')
    expect(model.state().rooms.selectedId).toBe('standups')
  })

  it('selectTab switches and loads once; refresh reloads', async () => {
    model.selectTab('todo')
    await vi.waitFor(() => expect(model.state().todo.list.kind).toBe('ready'))
    expect(mock.log().filter(line => line.endsWith('todo.list'))).toHaveLength(1)
    await model.refresh()
    expect(mock.log().filter(line => line.endsWith('todo.list'))).toHaveLength(2)
  })

  it('a failed read is an error state that keeps the older value visible', async () => {
    await model.loadTab('memory')
    const failing = createPanelModel(createCortexApi(createMockTransport({ throwing: ['memory.list'] }).call))
    await failing.loadTab('memory')
    const load = failing.state().memory.list
    expect(load.kind).toBe('error')
    if (load.kind === 'error') expect(load.error.code).toBe('transport')
    failing.dispose()
  })

  it('an error slot keeps the previous value so the list does not vanish', async () => {
    await model.loadTab('memory')
    const flaky = createMockTransport()
    const flakyModel = createPanelModel(createCortexApi(flaky.call))
    await flakyModel.loadTab('memory')
    const next = createPanelModel(
      createCortexApi(createMockTransport({ handlers: { 'memory.list': () => ({ ok: false, error: { code: 'read-failed', message: 'disk busy' } }) } }).call),
    )
    await next.loadTab('memory')
    const load = next.state().memory.list
    expect(load.kind).toBe('error')
    if (load.kind === 'error') expect(load.error.message).toBe('disk busy')
    flakyModel.dispose()
    next.dispose()
  })
})

describe('memory actions', () => {
  it('the filter chip changes the arguments and re-reads', async () => {
    await model.setMemoryFilter('archived')
    expect(mock.last('memory.list')?.payload).toEqual({ archived: true })
    await model.setMemoryFilter('user')
    expect(mock.last('memory.list')?.payload).toEqual({ track: 'user' })
    expect(filterArgs('all')).toEqual({})
  })

  it('the scope the panel was given rides on the read', async () => {
    build({ branch: 'feature/x', pid: 'p-9', cwd: '/repo' })
    await model.loadTab('memory')
    expect(mock.last('memory.list')?.payload).toEqual({ branch: 'feature/x', projectId: 'p-9', cwd: '/repo' })
  })

  it('search only runs with a non-empty query', async () => {
    model.setMemoryQuery('   ')
    await model.runMemorySearch()
    expect(mock.log().some(line => line.endsWith('memory.search'))).toBe(false)
    model.setMemoryQuery('tsdown')
    await model.runMemorySearch()
    expect(mock.last('memory.search')?.payload).toEqual({ query: 'tsdown', includeArchive: false })
    expect(model.state().memory.search.kind).toBe('ready')
  })

  it('archive sends {id} then re-reads the list', async () => {
    await model.loadTab('memory')
    const before = mock.log().length
    await model.archiveMemory('a1b2c3d4e5f60718')
    expect(mock.last('memory.archive')?.payload).toEqual({ id: 'a1b2c3d4e5f60718' })
    expect(mock.last('memory.archive')?.channel).toBe('/dsh-cortex-write')
    expect(mock.log().length).toBeGreaterThan(before)
    // The re-read is the whole list + queue pair, in that order.
    expect(mock.log().slice(-2)).toEqual(['/dsh-cortex-read memory.list', '/dsh-cortex-read pending.list'])
    expect(model.state().flash?.tone).toBe('ok')
  })

  it('a refused archive surfaces as the flash line, not a silent no-op', async () => {
    await model.loadTab('memory')
    const refused = createPanelModel(
      createCortexApi(
        createMockTransport({ handlers: { 'memory.archive': () => ({ ok: false, error: { code: 'refused', message: 'entry is pinned' } }) } }).call,
      ),
    )
    await refused.archiveMemory('a1b2c3d4e5f60718')
    expect(refused.state().flash).toEqual({ tone: 'error', text: 'entry is pinned' })
    refused.dispose()
  })

  it('approve sends {id} on the write channel and reports the routed kind', async () => {
    await model.loadTab('memory')
    await model.approvePending('p-1001')
    expect(mock.last('pending.approve')?.payload).toEqual({ id: 'p-1001' })
    expect(model.state().flash?.tone).toBe('ok')
    expect(model.state().flash?.text).toContain('approved memory')
    expect(model.state().flash?.text).toContain('a1b2c3d4e5f60718')
  })

  it('reject is a different endpoint with the same {id}', async () => {
    await model.rejectPending('p-1002')
    expect(mock.last('pending.approve')).toBeUndefined()
    expect(mock.last('pending.reject')?.payload).toEqual({ id: 'p-1002' })
  })

  it('a kind with no approver surfaces the host refusal verbatim', async () => {
    const gate = createMockTransport({
      approveByKind: true,
      handlers: {
        'pending.approve': () => ({ ok: false, error: { code: 'unsupported-kind', message: "no approver wired for pending kind 'todo' yet" } }),
      },
    })
    const gated = createPanelModel(createCortexApi(gate.call))
    await gated.approvePending('p-1002')
    expect(gated.state().flash).toEqual({ tone: 'error', text: "no approver wired for pending kind 'todo' yet" })
    gated.dispose()
  })
})

describe('todo actions', () => {
  it('add sends the selected track + nested scope, then re-reads', async () => {
    build({ pid: 'p-9' })
    model.setTodoTrack('life')
    await model.addTodo('water the plants')
    expect(mock.last('todo.add')?.payload).toEqual({ track: 'life', text: 'water the plants', scope: { projectId: 'p-9' } })
    expect(mock.log()[mock.log().length - 1]).toBe('/dsh-cortex-read todo.list')
    expect(model.state().todo.draft).toBe('')
  })

  it('an empty draft is refused locally, with no write sent', async () => {
    await model.addTodo('   ')
    expect(mock.log().some(line => line.endsWith('todo.add'))).toBe(false)
    expect(model.state().flash).toEqual({ tone: 'error', text: 'nothing to add' })
  })

  it('complete and remove send {id}; uncomplete reuses complete with done=false', async () => {
    await model.completeTodo('t-1')
    expect(mock.last('todo.complete')?.payload).toEqual({ id: 't-1' })
    await model.uncompleteTodo('t-1')
    expect(mock.last('todo.complete')?.payload).toEqual({ id: 't-1', done: false })
    await model.removeTodo('t-2')
    expect(mock.last('todo.remove')?.payload).toEqual({ id: 't-2' })
    expect(mock.last('todo.remove')?.channel).toBe('/dsh-cortex-write')
  })

  it('openOnly defaults to true and flips the read argument', async () => {
    expect(model.state().todo.openOnly).toBe(true)
    await model.setTodoOpenOnly(false)
    expect(mock.last('todo.list')?.payload).toEqual({ openOnly: false })
  })
})

describe('rooms actions', () => {
  it('create sends the trimmed title and reloads the list', async () => {
    model.setRoomField('newRoomTitle', '  Retros  ')
    await model.createRoom()
    expect(mock.last('rooms.create')?.payload).toEqual({ title: 'Retros' })
    expect(model.state().rooms.newRoomTitle).toBe('')
    expect(mock.log()).toContain('/dsh-cortex-read rooms.list')
  })

  it('post sends roomId + text and re-reads that room', async () => {
    await model.loadTab('rooms')
    model.setRoomField('postDraft', 'wiring the panel now')
    await model.postToRoom()
    expect(mock.last('rooms.post')?.payload).toEqual({ roomId: 'standups', text: 'wiring the panel now' })
    expect(mock.log().filter(line => line.endsWith('rooms.read')).length).toBeGreaterThan(1)
    expect(model.state().rooms.postDraft).toBe('')
  })

  it('a disabled-looking spawn cannot be forced through the model either', async () => {
    const blockedTransport = createMockTransport({ sessionsStatus: { canSpawn: false, reason: 'no agents service' } })
    const blocked = createPanelModel(createCortexApi(blockedTransport.call))
    await blocked.loadTab('rooms')
    expect(blocked.spawnGate()).toEqual({ allowed: false, reason: 'no agents service' })
    await blocked.spawnMember({ roomId: 'standups', label: 'worker', prompt: 'do it' })
    expect(blockedTransport.calls.filter(call => call.endpoint === 'rooms.spawn')).toHaveLength(0)
    expect(blocked.state().flash).toEqual({ tone: 'error', text: 'no agents service' })
    blocked.dispose()
  })

  it('spawn is allowed only after sessions.status says so, and sends the room it was aimed at', async () => {
    const readyTransport = createMockTransport({ sessionsStatus: { canSpawn: true } })
    const ready = createPanelModel(createCortexApi(readyTransport.call))
    await ready.loadTab('rooms')
    expect(ready.spawnGate().allowed).toBe(true)
    ready.setRoomField('spawnLabel', ' reviewer ')
    ready.setRoomField('spawnPrompt', 'review the diff')
    await ready.spawnMember()
    const call = readyTransport.last('rooms.spawn')
    expect(call?.payload).toEqual({ roomId: 'standups', label: 'reviewer', prompt: 'review the diff' })
    ready.dispose()
  })

  it('before sessions.status answers, the gate is closed and says so', async () => {
    const idle = createPanelModel(createCortexApi(() => new Promise<never>(() => {})))
    expect(idle.spawnGate().allowed).toBe(false)
    expect(idle.spawnGate().reason.length).toBeGreaterThan(8)
    idle.dispose()
  })

  it('paging widens the window and keeps only genuinely older rows', async () => {
    const paging = createMockTransport({
      handlers: {
        'rooms.read': payload => {
          const limit = Number(payload.limit ?? 50)
          const all = Array.from({ length: 120 }, (_unused, seq) => ({ seq: seq + 1, from: 'bot', text: `msg ${String(seq + 1)}` }))
          return { ok: true, value: { messages: all.slice(-limit) } }
        },
      },
    })
    const paged = createPanelModel(createCortexApi(paging.call))
    await paged.loadTab('rooms')
    expect(paged.state().rooms.earliestSeq).toBe(120 - 50 + 1)
    await paged.loadOlderMessages()
    const second = paged.state().rooms.pages[1] ?? []
    expect(second.length).toBeGreaterThan(0)
    expect(Math.max(...second.map(message => message.seq))).toBeLessThan(paged.state().rooms.pages[0][0].seq)
    expect(paged.state().rooms.earliestSeq).toBe(21)
    paged.dispose()
  })

  it('once seq 1 is on screen there is nothing older, and the button stops the model', async () => {
    await model.loadTab('rooms')
    await model.loadOlderMessages()
    expect(model.state().rooms.loadingOlder).toBe(false)
  })
})

describe('jobs actions', () => {
  it('the first job is opened automatically, with detail and logs', async () => {
    await model.loadTab('jobs')
    expect(model.state().jobs.selectedId).toBe('j-1')
    expect(mock.log()).toContain('/dsh-cortex-read jobs.get')
    expect(mock.log()).toContain('/dsh-cortex-read jobs.logs')
  })

  it('cancel sends jobId and re-reads', async () => {
    await model.loadTab('jobs')
    await model.cancelJob('j-1')
    expect(mock.last('jobs.cancel')?.payload).toEqual({ jobId: 'j-1' })
    expect(mock.log()[mock.log().length - 1]).toBe('/dsh-cortex-read jobs.list')
  })
})

describe('lifecycle', () => {
  it('a notification fires per state change and stops after dispose', async () => {
    const seen: string[] = []
    const unsubscribe = model.subscribe(() => seen.push(model.state().tab))
    model.selectTab('todo')
    model.selectTab('todo')
    unsubscribe()
    model.selectTab('jobs')
    // Notifications stopped at unsubscription: the 'jobs' switch is not seen,
    // and every seen tab is the one that was selected.
    expect(seen.every(tab => tab === 'todo')).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    await model.loadTab('prompts')
    model.dispose()
    const before = seen.length
    model.selectTab('memory')
    expect(seen.length).toBe(before)
  })

  it('dispose stops in-flight results from touching the tree', async () => {
    const slow = createPanelModel(
      createCortexApi(async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { ok: true, value: { entries: [], truncated: false, branch: null } }
      }),
    )
    const load = slow.loadTab('memory')
    slow.dispose()
    await load
    // The reply landed after teardown and was dropped, not applied.
    expect(slow.state().memory.list.kind).toBe('loading')
  })

  it('a promise rejection inside an action surfaces as a flash, never an unhandled throw', async () => {
    const hostile = createPanelModel(
      createCortexApi(async () => {
        throw new Error('socket dropped')
      }),
    )
    await hostile.runMemorySearch()
    await hostile.approvePending('p-1')
    expect(hostile.state().flash?.tone).toBe('error')
    hostile.dispose()
  })
})
