import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as todoModule from '../../src/host/modules/todo/index.ts'
import * as logsModule from '../../src/host/modules/logs/index.ts'
import * as progressModule from '../../src/host/modules/progress/index.ts'
import { TodoService } from '../../src/host/modules/todo/service.ts'
import { LogService } from '../../src/host/modules/logs/service.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { ALPHA, alphaPid, fakeAgent, makeHarness, runTool } from './helpers.ts'
import type { Harness } from './helpers.ts'
import type { ToolDefinition } from '../../src/host/dsh.ts'
import type { TodoItem } from '../../src/host/types.ts'

/**
 * Cross-cutting M3 checks: the boot rules (P4 never lets a failure out of
 * `apply`), the brace sweep (P9) across every string these modules can put in
 * front of a model, and the caps (P2) under an adversarial store.
 */

let harness: Harness

beforeEach(async () => {
  harness = await makeHarness({ now: new Date('2026-03-04T05:06:07.000Z') })
})

afterEach(async () => {
  todoModule.getTodoService()?.dispose()
  logsModule.getLogService()?.dispose()
  await harness.cleanup()
})

/** Every prose leaf of a tool definition: its description and each parameter's. */
function proseOf(definition: ToolDefinition): string[] {
  const prose = [definition.description]
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'description' && typeof child === 'string') prose.push(child)
        else walk(child)
      }
    }
  }
  walk(definition.parameters)
  return prose
}

describe('boot rules (P4)', () => {
  it('a second mount on the same host loses its tools and still does not throw', () => {
    todoModule.apply(harness.deps)
    expect(() => todoModule.apply(harness.deps)).not.toThrow()
    expect(harness.fake.registrationsRefused.sort()).toEqual([
      'cortex_todo_add', 'cortex_todo_complete', 'cortex_todo_list', 'cortex_todo_remove',
    ])
    expect(() => logsModule.apply(harness.deps)).not.toThrow()
    expect(() => progressModule.apply(harness.deps)).not.toThrow()
  })

  it('a host that refuses everything marks the module failed, with a message', async () => {
    const hostile = await makeHarness()
    try {
      hostile.fake.ctx.tools.register = (() => {
        throw new Error('tools service unavailable')
      }) as never
      hostile.fake.ctx.get = (() => undefined) as never
      expect(() => todoModule.apply(hostile.deps)).toThrow(/no tool registered/)
      expect(() => logsModule.apply(hostile.deps)).toThrow(/neither the tools nor the review-nudge seam/)
      expect(() => progressModule.apply(hostile.deps)).toThrow(/registration refused/)
    } finally {
      await hostile.cleanup()
    }
  })

  it('a corrupt todo file costs that file only, and the digest says what it sees', async () => {
    await harness.store.addTodo({ track: 'work', text: 'survivor in another file' })
    await writeFile(join(harness.root, 'todos', 'life.json'), '{ not json at all', 'utf8')
    const service = new TodoService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
    let cold = 'x'
    expect(() => {
      cold = service.contextText({ agent: fakeAgent(ALPHA) })
    }).not.toThrow()
    // A cold cache contributes nothing rather than a guess.
    expect(cold).toBe('')
    await service.warm(ALPHA)
    await service.settle()
    const after = service.contextText({ agent: fakeAgent(ALPHA) })
    expect(after).toContain('survivor in another file')
    const quarantined = await readdir(join(harness.root, 'quarantine'))
    expect(quarantined.some(name => name.startsWith('life.json.corrupt-'))).toBe(true)
    expect(harness.warnings.join('\n')).toContain('quarantined')
    service.dispose()
  })
})

describe('brace sweep (P9 / host issue-class #53)', () => {
  it('no tool or parameter description carries a brace pair', () => {
    todoModule.apply(harness.deps)
    logsModule.apply(harness.deps)
    progressModule.apply(harness.deps)
    expect([...harness.fake.tools.keys()].sort()).toEqual([
      'cortex_log_append', 'cortex_log_read', 'cortex_progress_report',
      'cortex_todo_add', 'cortex_todo_complete', 'cortex_todo_list', 'cortex_todo_remove',
    ])
    for (const definition of harness.fake.tools.values()) {
      for (const prose of proseOf(definition)) {
        expect(prose, `${definition.name} description`).not.toMatch(/\{\{|\}\}/)
      }
      expect(JSON.stringify(definition.output.schema), definition.name).not.toMatch(/\{\{|\}\}/)
    }
  })

  it('adversarial stored text cannot reach the digest, the log tail or the report', async () => {
    todoModule.apply(harness.deps)
    logsModule.apply(harness.deps)
    progressModule.apply(harness.deps)
    const pid = alphaPid()
    await harness.store.addTodo({ track: 'project', pid, text: 'wire {{{session}}} into {{user}}}}' })
    await harness.store.logAppend({ scope: 'project', pid, text: 'leaked {{config}} and {{{{{{' })
    await harness.store.addEntry({ scope: { track: 'project', pid }, content: 'value: {{memory}}' })
    // Hand-write a row that never passed the store's choke point: the render
    // edge is the only thing standing between it and the host prompt renderer.
    const hostile: TodoItem = {
      id: 'aaaaaaaaaaaa',
      track: 'project',
      text: 'raw {{template}} leak }}',
      done: false,
      createdAt: '2026-03-01T00:00:00.000Z',
    }
    await writeFile(join(harness.root, 'projects', pid, 'todos.json'), JSON.stringify([hostile]), 'utf8')
    const agent = fakeAgent(ALPHA, 'session-sweep')
    const service = todoModule.getTodoService()
    expect(service).not.toBeNull()
    await service?.warm(ALPHA)
    await service?.settle()
    const digest = service?.contextText({ agent }) ?? ''
    const logRead = await runTool(harness.fake, 'cortex_log_read', { scope: 'project', pid }, agent)
    const report = await runTool(harness.fake, 'cortex_progress_report', {}, agent)
    const listTool = await runTool(harness.fake, 'cortex_todo_list', { openOnly: false }, agent)
    for (const blob of [digest, JSON.stringify(logRead), JSON.stringify(report), JSON.stringify(listTool)]) {
      expect(blob).not.toContain('{{')
      expect(blob).not.toContain('}}')
    }
    // The rule breaks every adjacent run with a space, preserving each brace,
    // so `}}` becomes `} }` — never a re-formable pair, never a rewritten brace.
    expect(digest).toContain('raw { {template} } leak } }')
  })
})

describe('path safety (P5): a caller-supplied project id', () => {
  it('refuses ids the store would join into a path', async () => {
    const service = new TodoService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
    for (const hostile of ['../../etc', 'a/b', '', 'x'.repeat(80), '../user']) {
      const result = await service.addTodo({ track: 'project', text: 'traversal attempt', pid: hostile }, fakeAgent(ALPHA))
      expect(result.ok, `pid "${hostile}" must not be accepted`).toBe(false)
      expect(result.message).toContain('project id')
    }
    const logService = new LogService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
    expect((await logService.append({ scope: 'project', text: 'x', pid: '../../etc' }, fakeAgent(ALPHA))).ok).toBe(false)
    expect((await logService.read({ scope: 'project', pid: '../..' }, fakeAgent(ALPHA))).ok).toBe(false)
    const projects = await readdir(join(harness.root, 'projects')).catch(() => [])
    expect(projects.every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true)
  })
})

describe('caps under load (P2)', () => {
  it('500 open todos still inject within caps.todoDigestChars', async () => {
    const rows: TodoItem[] = Array.from({ length: 500 }, (_unused, index) => ({
      id: `id${String(index).padStart(10, '0')}`,
      track: 'life',
      text: `item ${String(index)} ${'q'.repeat(400)}`,
      done: false,
      createdAt: `2026-02-${String((index % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
      due: `2026-03-${String((index % 27) + 1).padStart(2, '0')}`,
    }))
    await mkdir(join(harness.root, 'todos'), { recursive: true })
    await writeFile(join(harness.root, 'todos', 'life.json'), JSON.stringify(rows), 'utf8')
    const service = new TodoService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
    harness.config.caps = { ...harness.config.caps, todoDigestChars: 320 }
    await service.warm(ALPHA)
    await service.settle()
    const rendered = service.contextText({ agent: fakeAgent(ALPHA) })
    expect(rendered.length).toBeLessThanOrEqual(320)
    expect(rendered.startsWith(harness.config.injectLabel)).toBe(true)
    expect(rendered).toMatch(/\[… \d+ more/)
    // Injection is a window, not a limit: the store still holds every row.
    expect((await service.allTodos({ openOnly: true })).length).toBe(500)
    service.dispose()
  })

  it('the shipped budgets are the DESIGN §3 / brief numbers', () => {
    expect(DEFAULT_CAPS.todoDigestChars).toBe(1024)
    expect(DEFAULT_CAPS.logLineChars).toBe(500)
    expect(DEFAULT_CAPS.logDayChars).toBe(20000)
    expect(progressModule.PROGRESS_BUDGET_CHARS).toBe(4000)
    expect(logsModule.MAX_LAST_DAYS).toBe(7)
  })

  it('a day past its cap rolls into parts, each within the cap', async () => {
    harness.config.caps = { ...harness.config.caps, logDayChars: 200 }
    for (let index = 0; index < 12; index += 1) {
      await harness.store.logAppend({ scope: 'daily', text: `line ${String(index)} ${'w'.repeat(80)}` })
    }
    const dir = join(harness.root, 'daily')
    const names = (await readdir(dir)).filter(name => name.startsWith('2026-03-04')).sort()
    expect(names.length).toBeGreaterThan(1)
    for (const name of names) {
      expect((await readFile(join(dir, name), 'utf8')).length).toBeLessThanOrEqual(200)
    }
  })
})
