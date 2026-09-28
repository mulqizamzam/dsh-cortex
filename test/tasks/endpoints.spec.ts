import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as todoModule from '../../src/host/modules/todo/index.ts'
import * as logsModule from '../../src/host/modules/logs/index.ts'
import * as progressModule from '../../src/host/modules/progress/index.ts'
import { callEndpoint, makeHarness } from './helpers.ts'
import type { Harness } from './helpers.ts'
import { isSafeKey } from '../../src/lib/ids.ts'
import type { TodoItem } from '../../src/host/types.ts'

/**
 * The endpoint half of the M3 contract (`.dev/RPC-ENDPOINTS.md`): the maps the
 * parent merges into `/dsh-cortex-read` and `/dsh-cortex-write`.
 *
 * The rule under test is the human path: `todo.add` on the write channel writes
 * IMMEDIATELY, with no pending row. The pending queue gates AI-authored
 * content, and a call on the loopback-fenced channel is a click, not a turn.
 */

let harness: Harness

const PANEL_CWD = '/dsh-cortex-endpoint-test/not-a-repo'

beforeEach(async () => {
  harness = await makeHarness({ now: new Date('2026-03-04T05:06:07.000Z') })
  todoModule.apply(harness.deps)
  logsModule.apply(harness.deps)
  progressModule.apply(harness.deps)
})

afterEach(async () => {
  todoModule.getTodoService()?.dispose()
  logsModule.getLogService()?.dispose()
  await harness.cleanup()
})

describe('module faces', () => {
  it('every M3 module exports the wiring contract the parent mounts', () => {
    for (const module of [todoModule, logsModule, progressModule]) {
      expect(typeof module.name).toBe('string')
      expect(Array.isArray(module.TOOLS)).toBe(true)
      expect(typeof module.apply).toBe('function')
      expect(module.readEndpoints).toBeTypeOf('object')
      expect(module.writeEndpoints).toBeTypeOf('object')
    }
    expect([todoModule.name, logsModule.name, progressModule.name]).toEqual(['todo', 'logs', 'progress'])
    expect([...todoModule.TOOLS]).toEqual(['cortex_todo_add', 'cortex_todo_list', 'cortex_todo_complete', 'cortex_todo_remove'])
    expect([...logsModule.TOOLS]).toEqual(['cortex_log_append', 'cortex_log_read'])
    expect([...progressModule.TOOLS]).toEqual(['cortex_progress_report'])
  })

  it('endpoint names match the frozen contract, nothing extra', () => {
    expect(Object.keys(todoModule.readEndpoints)).toEqual(['todo.list'])
    expect(Object.keys(todoModule.writeEndpoints).sort()).toEqual(['todo.add', 'todo.complete', 'todo.remove'])
    expect(Object.keys(logsModule.readEndpoints)).toEqual(['logs.read'])
    expect(Object.keys(logsModule.writeEndpoints)).toEqual([])
    // Progress is tool-only by brief: it exposes no endpoint at all.
    expect(Object.keys(progressModule.readEndpoints)).toEqual([])
    expect(Object.keys(progressModule.writeEndpoints)).toEqual([])
  })

  it('an unmapped endpoint or a junk payload answers as an envelope, never a throw', async () => {
    const missing = await callEndpoint(todoModule.writeEndpoints, 'todo.frobnicate', {})
    expect(missing.ok, 'a name this module does not own is not answered').toBe(false)
    expect(missing.error?.code).toBe('unknown-endpoint')
    expect((await todoModule.writeEndpoints['todo.remove']('not-an-object')).ok).toBe(false)
    expect((await todoModule.writeEndpoints['todo.remove']({ id: '../../etc/passwd' })).ok).toBe(false)
    expect((await todoModule.readEndpoints['todo.list'](undefined)).ok).toBe(true)
    expect((await logsModule.readEndpoints['logs.read']({})).ok).toBe(false)
  })
})

describe('todo.* endpoints — the direct human path', () => {
  it('todo.add writes the item and never touches the pending queue', async () => {
    const created = await callEndpoint(todoModule.writeEndpoints, 'todo.add', {
      track: 'life', text: 'book the dentist', due: '2026-03-20', important: true,
    })
    expect(created.ok, JSON.stringify(created.error)).toBe(true)
    const item = created.value as TodoItem
    expect(item.id).toMatch(/^[a-f0-9]{12}$/)
    expect(item.track).toBe('life')
    expect(item.due).toBe('2026-03-20')
    expect(item.done).toBe(false)
    const pending = await harness.store.listPending()
    expect(pending.ok && pending.data).toHaveLength(0)
    const listed = await callEndpoint(todoModule.readEndpoints, 'todo.list', {})
    const rows = (listed.value as { items: TodoItem[] }).items
    expect(rows.map(row => row.text)).toContain('book the dentist')
  })

  it('todo.add validates types by hand: track, text and due', async () => {
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.add', {})).error?.code).toBe('command-error') // projected; ours rides in the message
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'mood', text: 'x' })).error?.code).toBe('command-error') // projected; ours rides in the message
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'work' })).error?.code).toBe('command-error') // projected; ours rides in the message
    const badDue = await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'work', text: 'x', due: 'someday' })
    expect(badDue.ok).toBe(false)
    expect(badDue.error?.message).toContain('YYYY-MM-DD')
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.add', null)).error?.code).toBe('command-error') // projected; ours rides in the message
    const work = await harness.store.listTodos({ tracks: ['work'] })
    expect(work.ok && work.data).toHaveLength(0)
  })

  it('a project add over RPC needs an explicit projectId and lands under that pid', async () => {
    const noScope = await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'project', text: 'needs a project' })
    expect(noScope.ok).toBe(false)
    expect(noScope.error?.message).toMatch(/project/i)
    const pid = 'beefbeefbeefbeef'
    const created = await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'project', text: 'panel-authored', scope: { projectId: pid } })
    expect(created.ok, JSON.stringify(created.error)).toBe(true)
    expect(await readFile(join(harness.root, 'projects', pid, 'todos.json'), 'utf8')).toContain('panel-authored')
    const listed = await callEndpoint(todoModule.readEndpoints, 'todo.list', { scope: { projectId: pid } })
    expect(((listed.value as { items: TodoItem[] }).items).map(item => item.text)).toEqual(['panel-authored'])
    // A traversal-shaped id is refused, never joined into a path.
    expect(isSafeKey('../user')).toBe(false)
    const hostile = await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'project', text: 'x', scope: { projectId: '../user' } })
    expect(hostile.ok).toBe(false)
  })

  it('todo.complete and todo.remove report honestly through the channel', async () => {
    const created = await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'work', text: 'temporary' })
    const id = (created.value as TodoItem).id
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.complete', { id })).ok).toBe(true)
    const open = await callEndpoint(todoModule.readEndpoints, 'todo.list', {})
    expect(((open.value as { items: TodoItem[] }).items).find(item => item.id === id)).toBeUndefined()
    const everything = await callEndpoint(todoModule.readEndpoints, 'todo.list', { openOnly: false })
    const rows = (everything.value as { items: Array<TodoItem & { overdue?: boolean }> }).items
    expect(rows.find(item => item.id === id)?.done).toBe(true)
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.complete', { id })).ok).toBe(false)
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.remove', { id })).ok).toBe(true)
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.remove', { id })).ok).toBe(false)
    expect((await callEndpoint(todoModule.writeEndpoints, 'todo.remove', {})).error?.code).toBe('command-error') // projected; ours rides in the message
  })

  it('todo.list answers with both rows and pre-rendered lines, brace-safe', async () => {
    await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'daily', text: 'try {{template}} injection }} here' })
    const listed = await callEndpoint(todoModule.readEndpoints, 'todo.list', {})
    const value = listed.value as { items: Array<{ text: string }>; lines: string[]; truncated: boolean }
    expect(JSON.stringify(value)).not.toContain('{{')
    expect(JSON.stringify(value)).not.toContain('}}')
    expect(value.lines[0]).toContain('{ {template} }')
    expect(value.truncated).toBe(false)
  })

  it('a UI add reaches the injected digest without waiting for the TTL', async () => {
    const service = todoModule.getTodoService()
    expect(service).not.toBeNull()
    const agent = { id: 'session-panel', session: { header: { cwd: PANEL_CWD } } }
    await callEndpoint(todoModule.writeEndpoints, 'todo.add', { track: 'life', text: 'from the panel' })
    // First render is cold for this cwd: it primes the scope and says nothing.
    expect(service?.contextText({ agent })).toBe('')
    await service?.settle()
    expect(service?.contextText({ agent }) ?? '').toContain('from the panel')
  })
})

describe('logs.read endpoint (contract)', () => {
  it('refuses without a project id and answers per-day rows with one', async () => {
    const noProject = await callEndpoint(logsModule.readEndpoints, 'logs.read', { scope: 'project' })
    expect(noProject.ok).toBe(false)
    expect(noProject.error?.message).toContain('projectId')
    await harness.store.logAppend({ scope: 'project', pid: 'beefbeefbeefbeef', text: 'row from the store' })
    const read = await callEndpoint(logsModule.readEndpoints, 'logs.read', { scope: 'project', projectId: 'beefbeefbeefbeef' })
    expect(read.ok).toBe(true)
    const value = read.value as { days: Array<{ date: string; text: string }> }
    expect(JSON.stringify(value)).toContain('row from the store')
  })
})
