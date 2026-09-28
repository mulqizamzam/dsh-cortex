import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampText } from '../../src/lib/caps.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { TodoService } from '../../src/host/modules/todo/service.ts'
import { todoTools } from '../../src/host/modules/todo/tools.ts'
import {
  EMPTY_DIGEST_LINE, TODO_CONTEXT_NAME, TODO_CONTEXT_ORDER, daysUntil, formatTodoLine, isOverdue,
  orderForDigest, parseDue, renderTodoDigest, todoHeader,
} from '../../src/host/modules/todo/digest.ts'
import { INJECT_LABEL } from '../../src/host/config.ts'
import type { TodoItem } from '../../src/host/types.ts'
import { ALPHA, BETA, alphaPid, betaPid, fakeAgent, makeHarness, renderContext, runTool } from './helpers.ts'
import type { Harness } from './helpers.ts'

/** M3 acceptance: due-date handling, digest caps, empty state, project isolation. */

let harness: Harness
let svc: TodoService

const item = (over: Partial<TodoItem>): TodoItem => ({
  id: 'id0000000001',
  track: 'life',
  text: 'task',
  done: false,
  createdAt: '2026-03-01T10:00:00.000Z',
  ...over,
})

beforeEach(async () => {
  harness = await makeHarness({ now: new Date('2026-03-04T05:06:07.000Z') })
  svc = new TodoService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
  svc.install()
  for (const definition of todoTools(svc)) harness.fake.ctx.tools.register(definition)
})

afterEach(async () => {
  svc.dispose()
  await harness.cleanup()
})

describe('due-date contract', () => {
  it('accepts a real YYYY-MM-DD and nothing else', () => {
    expect(parseDue('2026-03-10')).toEqual({ ok: true, due: '2026-03-10' })
    expect(parseDue('  2026-03-10  ')).toEqual({ ok: true, due: '2026-03-10' })
    expect(parseDue(undefined)).toEqual({ ok: true })
    expect(parseDue('')).toEqual({ ok: true })
  })

  it('refuses vague and impossible dates with a sentence, never a guess', () => {
    for (const bad of ['tomorrow', 'next friday', '2026/03/10', '10-03-2026', '2026-02-31', '2026-13-01', '0000-00-00']) {
      const result = parseDue(bad)
      expect(result.ok, bad).toBe(false)
      if (!result.ok) expect(result.error.length, bad).toBeGreaterThan(10)
    }
    const numeric = parseDue(20260310)
    expect(numeric.ok).toBe(false)
  })

  it('an add with a bad due never reaches the store, and says so in words', async () => {
    const result = await runTool(harness.fake, 'cortex_todo_add', { track: 'life', text: 'buy milk', due: 'someday' }, fakeAgent(ALPHA))
    expect(result.status).toBe('refused')
    expect(String(result.message)).toContain('YYYY-MM-DD')
    expect(result.todo).toBeNull()
    expect(await svc.allTodos({ openOnly: false })).toHaveLength(0)
  })

  it('a good add lands, is listed by id, and completes through the tool', async () => {
    const agent = fakeAgent(ALPHA)
    const added = await runTool(harness.fake, 'cortex_todo_add', { track: 'project', text: 'fix flaky spec', due: '2026-03-05', urgent: true }, agent)
    expect(added.status).toBe('added')
    const id = (added.todo as { id: string }).id
    const listed = await runTool(harness.fake, 'cortex_todo_list', {}, agent)
    expect(String(listed.summary)).toContain('1 todo')
    expect((listed.lines as string[]).join('\n')).toContain('fix flaky spec')
    expect((listed.lines as string[]).join('\n')).toContain(`id=${id}`)
    const done = await runTool(harness.fake, 'cortex_todo_complete', { id }, agent)
    expect(done.status).toBe('completed')
    const gone = await runTool(harness.fake, 'cortex_todo_complete', { id: 'ffffffffffff' }, agent)
    expect(gone.status).toBe('refused')
    expect(String(gone.message)).toContain('ffffffffffff')
  })

  it('cortex_todo_list respects openOnly and the track filter', async () => {
    const agent = fakeAgent(ALPHA)
    await svc.addTodo({ track: 'work', text: 'quarterly report' }, agent)
    const projectId = await svc.addTodo({ track: 'project', text: 'alpha work' }, agent)
    void projectId
    const onlyWork = await runTool(harness.fake, 'cortex_todo_list', { tracks: ['work'] }, agent)
    expect((onlyWork.lines as string[]).join('\n')).not.toContain('alpha work')
    const everything = await runTool(harness.fake, 'cortex_todo_list', {}, agent)
    expect(everything.count).toBe(2)
    await svc.completeTodo((await svc.allTodos({ pid: alphaPid(), openOnly: true }))[0]?.id, agent)
    const withDone = await runTool(harness.fake, 'cortex_todo_list', { openOnly: false }, agent)
    expect(withDone.count).toBe(2)
    expect((await runTool(harness.fake, 'cortex_todo_list', { openOnly: true }, agent)).count).toBe(1)
  })
})

describe('digest ordering and flags', () => {
  const today = '2026-03-04'

  it('dated items first, due ascending, then urgent/important, then age', () => {
    const items = [
      item({ id: 'a', text: 'undated plain', createdAt: '2026-01-01T00:00:00.000Z' }),
      item({ id: 'b', text: 'due in a week', due: '2026-03-11' }),
      item({ id: 'c', text: 'overdue', due: '2026-03-01' }),
      item({ id: 'd', text: 'urgent undated', urgent: true }),
      item({ id: 'e', text: 'important undated', important: true }),
      item({ id: 'f', text: 'due today', due: '2026-03-04' }),
    ]
    expect(orderForDigest(items).map(row => row.id)).toEqual(['c', 'f', 'b', 'd', 'e', 'a'])
  })

  it('marks overdue strictly (due today is not overdue)', () => {
    expect(isOverdue('2026-03-03', today)).toBe(true)
    expect(isOverdue('2026-03-04', today)).toBe(false)
    expect(isOverdue(undefined, today)).toBe(false)
    expect(daysUntil('2026-03-01', today)).toBe(-3)
    const line = formatTodoLine(item({ text: 'ship it', due: '2026-03-01' }), today)
    expect(line).toContain('OVERDUE 3d')
    expect(formatTodoLine(item({ text: 'later', due: '2026-03-09' }), today)).not.toContain('OVERDUE')
  })

  it('completed items never render, and the header counts what is open', () => {
    const rendered = renderTodoDigest({
      items: [item({ text: 'open one' }), item({ text: 'done one', done: true })],
      label: INJECT_LABEL,
      budget: DEFAULT_CAPS.todoDigestChars,
      today,
    })
    expect(rendered.text).toContain('open one')
    expect(rendered.text).not.toContain('done one')
    expect(rendered.overdue).toBe(0)
    expect(todoHeader(3, 1)).toContain('3 open, 1 overdue')
    expect(todoHeader(3, 0)).toContain('none overdue')
  })
})

describe('digest budget and honesty (P1/P2)', () => {
  const today = '2026-03-04'

  it('starts with the honest label on every path', () => {
    const full = renderTodoDigest({ items: [item({ text: 'a' })], label: INJECT_LABEL, budget: 1024, today })
    const empty = renderTodoDigest({ items: [], label: INJECT_LABEL, budget: 1024, today })
    expect(full.text.startsWith(`${INJECT_LABEL}\n`)).toBe(true)
    expect(empty.text.startsWith(`${INJECT_LABEL}\n`)).toBe(true)
  })

  it('renders one plain line when nothing is open', () => {
    const rendered = renderTodoDigest({ items: [], label: INJECT_LABEL, budget: 1024, today })
    expect(rendered.text).toBe(`${INJECT_LABEL}\n${EMPTY_DIGEST_LINE}`)
    expect(rendered.omitted).toBe(0)
  })

  it('never exceeds the budget, and counts what it dropped', () => {
    const many = Array.from({ length: 60 }, (_unused, index) =>
      item({ id: `id${String(index).padStart(8, '0')}`, text: `item number ${String(index)} ${'y'.repeat(80)}`, due: `2026-03-${String((index % 27) + 1).padStart(2, '0')}` }))
    for (const budget of [DEFAULT_CAPS.todoDigestChars, 600, 240, 120]) {
      const rendered = renderTodoDigest({ items: many, label: INJECT_LABEL, budget, today })
      expect(rendered.text.length, `budget ${String(budget)}`).toBeLessThanOrEqual(budget)
      // Anything left out is either said out loud or the block is silent —
      // there is no third option where items vanish without a word.
      if (rendered.omitted > 0 && !rendered.suppressed) expect(rendered.text).toMatch(/\[… \d+ more/)
      if (rendered.suppressed) expect(rendered.text).toBe('')
      expect(rendered.shown + rendered.omitted).toBe(many.length)
    }
  })

  it('a budget too small to carry the label contributes nothing', () => {
    const rendered = renderTodoDigest({ items: [item({ text: 'a' })], label: INJECT_LABEL, budget: 30, today })
    expect(rendered.text).toBe('')
    expect(rendered.suppressed).toBe(true)
    // Same for the empty state: no label room, no block. Never an unlabelled one.
    expect(renderTodoDigest({ items: [], label: INJECT_LABEL, budget: 8, today }).text).toBe('')
  })

  it('neutralises brace pairs from stored text at the render edge', () => {
    const rendered = renderTodoDigest({
      items: [item({ text: 'wire {{session}} into {{user}} and close the loop }} now' })],
      label: INJECT_LABEL,
      budget: 1024,
      today,
    })
    expect(rendered.text).not.toContain('{{')
    expect(rendered.text).not.toContain('}}')
    expect(rendered.text).toContain('{ {session} }')
  })

  it('a long line is clamped, never truncated mid-word-marker', () => {
    const rendered = renderTodoDigest({ items: [item({ text: 'z'.repeat(900) })], label: INJECT_LABEL, budget: 1024, today })
    expect(rendered.text.length).toBeLessThanOrEqual(1024)
    expect(rendered.text).toContain(clampText('z'.repeat(900), 180))
  })
})

describe('todo flows through the service', () => {
  it('add → list → complete → remove, with the done stamp', async () => {
    const added = await svc.addTodo({ track: 'work', text: 'write the digest', due: '2026-03-06', important: true }, undefined)
    expect(added.ok, added.message).toBe(true)
    const id = (added.item as TodoItem).id
    const listed = await svc.allTodos({ openOnly: true })
    expect(listed.map(row => row.id)).toContain(id)
    const done = await svc.completeTodo(id, undefined)
    expect(done.ok, done.message).toBe(true)
    expect(done.item?.done).toBe(true)
    expect(done.item?.completedAt).toBe('2026-03-04T05:06:07.000Z')
    expect((await svc.openTodos()).find(row => row.id === id)).toBeUndefined()
    const removed = await svc.removeTodo(id, undefined)
    expect(removed.ok, removed.message).toBe(true)
    expect((await svc.allTodos({ openOnly: false })).find(row => row.id === id)).toBeUndefined()
  })

  it('refuses unknown ids and malformed input as sentences', async () => {
    expect((await svc.completeTodo('nope-nope-nope', undefined)).ok).toBe(false)
    expect((await svc.completeTodo('a/b/../etc', undefined)).ok).toBe(false)
    expect((await svc.removeTodo(undefined, undefined)).ok).toBe(false)
    expect((await svc.addTodo({ track: 'sleep', text: 'x' }, undefined)).ok).toBe(false)
    expect((await svc.addTodo({ track: 'life', text: '   ' }, undefined)).ok).toBe(false)
    expect((await svc.addTodo({ track: 'life', text: 'x', due: 'nope' }, undefined)).message).toContain('YYYY-MM-DD')
  })

  it('the digest snapshot goes empty→one→gone as the data changes', async () => {
    const agent = fakeAgent(ALPHA)
    // A cold cache contributes nothing at all (no faked data on turn one)…
    expect(renderContext(harness.fake, TODO_CONTEXT_NAME, { agent })).toBe('')
    // …the warm-up loads the real state, and an empty store says so plainly.
    await svc.warm(ALPHA)
    await svc.settle()
    expect(renderContext(harness.fake, TODO_CONTEXT_NAME, { agent })).toContain(EMPTY_DIGEST_LINE)
    await svc.addTodo({ track: 'life', text: 'renew passport', due: '2026-03-20' }, agent)
    await svc.settle()
    const afterAdd = renderContext(harness.fake, TODO_CONTEXT_NAME, { agent })
    expect(afterAdd).toContain('renew passport')
    expect(afterAdd).toContain('due 2026-03-20')
    expect(afterAdd.startsWith(INJECT_LABEL)).toBe(true)
    const listed = await svc.allTodos({ openOnly: true })
    await svc.removeTodo(listed[0]?.id, agent)
    await svc.settle()
    expect(renderContext(harness.fake, TODO_CONTEXT_NAME, { agent })).toContain(EMPTY_DIGEST_LINE)
  })

  it('registers exactly one context seam, at the contract name and order', () => {
    expect(harness.fake.contexts.map(row => row.name)).toEqual([TODO_CONTEXT_NAME])
    expect(TODO_CONTEXT_NAME).toBe('cortex:todo')
    expect(harness.fake.contexts[0]?.order).toBe(TODO_CONTEXT_ORDER)
    expect(TODO_CONTEXT_ORDER).toBe(41)
  })

  it('a host without the prompt-context service still wires the tools (P4)', async () => {
    const blind = await makeHarness()
    try {
      blind.fake.ctx.get = ((name: string) => name === 'systemPrompt' ? undefined : undefined) as never
      const blindService = new TodoService({ deps: blind.deps, scopes: blind.scopes })
      expect(() => blindService.install()).not.toThrow()
      expect(blindService.hasContextSeam).toBe(false)
      expect(blind.warnings.join('\n')).toContain('systemPrompt.context unavailable')
      blindService.dispose()
    } finally {
      await blind.cleanup()
    }
  })

  it('a context registration that throws at the host is caught, not propagated', async () => {
    const hostile = await makeHarness()
    try {
      hostile.fake.ctx.get = ((name: string) => (name === 'systemPrompt'
        ? { context: () => { throw new Error('duplicate prompt context') } }
        : undefined)) as never
      const hostileService = new TodoService({ deps: hostile.deps, scopes: hostile.scopes })
      expect(() => hostileService.install()).not.toThrow()
      expect(hostileService.hasContextSeam).toBe(false)
      expect(hostile.warnings.join('\n')).toContain('context registration refused')
      hostileService.dispose()
    } finally {
      await hostile.cleanup()
    }
  })

  it('contributes nothing while injection is switched off (P3 switch)', async () => {
    await svc.addTodo({ track: 'work', text: 'hidden while off' }, undefined)
    await svc.warm(ALPHA)
    harness.config.inject = { ...harness.config.inject, todo: false }
    expect(renderContext(harness.fake, TODO_CONTEXT_NAME, { agent: fakeAgent(ALPHA) })).toBe('')
    harness.config.inject = { ...harness.config.inject, todo: true, enabled: false }
    expect(renderContext(harness.fake, TODO_CONTEXT_NAME, { agent: fakeAgent(ALPHA) })).toBe('')
  })
})

describe('project track isolation by pid', () => {
  it('a project todo is filed under the session repo and invisible to another', async () => {
    const alpha = fakeAgent(ALPHA, 'session-alpha')
    const added = await svc.addTodo({ track: 'project', text: 'fix the alpha build' }, alpha)
    expect(added.ok, added.message).toBe(true)
    const alphaList = await svc.allTodos({ pid: alphaPid(), openOnly: true })
    const betaList = await svc.allTodos({ pid: betaPid(), openOnly: true })
    expect(alphaList.map(row => row.text)).toContain('fix the alpha build')
    expect(betaList.map(row => row.text)).not.toContain('fix the alpha build')
    expect((alphaList[0] as TodoItem).track).toBe('project')
  })

  it('the digest follows the calling session: same repo sees it, other repo does not', async () => {
    await svc.addTodo({ track: 'project', text: 'alpha-only work' }, fakeAgent(ALPHA, 'a'))
    await svc.warm(ALPHA)
    await svc.warm(BETA)
    const inAlpha = renderContext(harness.fake, TODO_CONTEXT_NAME, { agent: fakeAgent(ALPHA, 'a') })
    const inBeta = renderContext(harness.fake, TODO_CONTEXT_NAME, { agent: fakeAgent(BETA, 'b') })
    expect(inAlpha).toContain('alpha-only work')
    expect(inBeta).not.toContain('alpha-only work')
    // Both sessions still see the shared buckets, and neither fakes a project.
    expect(inBeta).toContain(EMPTY_DIGEST_LINE)
  })

  it('a project add without a usable scope is refused, not filed as "unknown"', async () => {
    const result = await svc.addTodo({ track: 'project', text: 'orphan?' }, undefined)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('life')
    const snapshot = await harness.store.listTodos({ tracks: ['project'], pid: 'unknown' })
    expect(snapshot.ok && snapshot.data).toHaveLength(0)
  })

  it('no agent at all contributes an empty block instead of a guess', () => {
    expect(renderContext(harness.fake, TODO_CONTEXT_NAME, {})).not.toContain('alpha-only')
    expect(renderContext(harness.fake, TODO_CONTEXT_NAME, undefined)).toBe('')
  })
})

describe('tool registration', () => {
  it('four tools, cortex_-prefixed, with brace-free descriptions', () => {
    const definitions = todoTools(new TodoService({ deps: harness.deps, scopes: harness.scopes }))
    expect(definitions.map(definition => definition.name)).toEqual([
      'cortex_todo_add', 'cortex_todo_list', 'cortex_todo_complete', 'cortex_todo_remove',
    ])
    for (const definition of definitions) {
      // Descriptions are model-visible prose (the JSON structure's own braces
      // are not): check every prose leaf, never a stringified skeleton.
      const prose: string[] = [definition.description]
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk)
        if (value !== null && typeof value === 'object') {
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === 'description' && typeof child === 'string') prose.push(child)
            else walk(child)
          }
        }
      }
      walk(definition.parameters)
      for (const line of prose) {
        expect(line, definition.name).not.toContain('{{')
        expect(line, definition.name).not.toContain('}}')
      }
    }
  })
})
