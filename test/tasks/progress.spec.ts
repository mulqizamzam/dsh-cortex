import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROGRESS_BUDGET_CHARS, PROGRESS_ENTRY_LIMIT, PROGRESS_LOG_DAYS, collectProgress, progressHeader, renderProgress,
} from '../../src/host/modules/progress/report.ts'
import type { ProgressSource } from '../../src/host/modules/progress/report.ts'
import { ProgressService, TOOLS as PROGRESS_TOOLS } from '../../src/host/modules/progress/index.ts'
import { INJECT_LABEL } from '../../src/host/config.ts'
import { neutralize } from '../../src/lib/sanitize.ts'
import { ALPHA, alphaPid, fakeAgent, makeHarness, runTool } from './helpers.ts'
import type { Harness } from './helpers.ts'
import type { Entry, TodoItem } from '../../src/host/types.ts'

/** M3 acceptance: the progress report is composed, capped and labelled. */

let harness: Harness
let progress: ProgressService

const todo = (over: Partial<TodoItem>): TodoItem => ({
  id: 'todo00000001',
  track: 'work',
  text: 'open work item',
  done: false,
  createdAt: '2026-03-01T00:00:00.000Z',
  ...over,
})

const entry = (over: Partial<Entry>): Entry => ({
  id: 'entry00000001',
  track: 'project',
  content: 'we ship with pnpm',
  importance: 3,
  tags: [],
  createdAt: '2026-03-02T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z',
  origin: 'user',
  ...over,
})

/** A source that reads nothing but what it is handed. */
function fakeSource(over: Partial<ProgressSource> = {}): ProgressSource {
  return {
    listTodos: async () => [],
    readLog: async () => ({ text: '' }),
    listEntries: async () => [],
    today: () => '2026-03-04',
    label: () => INJECT_LABEL,
    ...over,
  }
}

beforeEach(async () => {
  harness = await makeHarness({ now: new Date('2026-03-04T05:06:07.000Z') })
  progress = new ProgressService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
  harness.fake.ctx.tools.register(progress.tool())
})

afterEach(async () => {
  await harness.cleanup()
})

describe('composition', () => {
  it('lists open todos, the recent log and the newest entries — nothing invented', async () => {
    const result = await collectProgress(fakeSource({
      listTodos: async () => [todo({ text: 'ship the report' }), todo({ id: 'done1', text: 'already finished', done: true })],
      readLog: async scope => (scope === 'project' ? { text: `- logged decision\n- logged fix` } : { text: '- cross-project note' }),
      listEntries: async () => [entry({ content: 'pnpm is the package manager' })],
      pid: async () => alphaPid(),
    }), fakeAgent(ALPHA))
    expect(result.text).toContain('ship the report')
    expect(result.text).not.toContain('already finished')
    expect(result.text).toContain('logged fix')
    expect(result.text).toContain('cross-project note')
    expect(result.text).toContain('pnpm is the package manager')
    expect(result.text).toContain(PROGRESS_LOG_DAYS === 3 ? '### log' : 'log')
    expect(result.truncated).toBe(false)
  })

  it('says so, plainly, when the store holds nothing', async () => {
    const result = await collectProgress(fakeSource(), undefined)
    expect(result.text.startsWith(`${INJECT_LABEL}\n`)).toBe(true)
    expect(result.text).toContain('(none)')
    expect(result.text).toContain('nothing summarised automatically')
    expect(result.text).not.toMatch(/all done|great job|looks good/i)
  })

  it('a read that failed is reported as failed, not as empty', async () => {
    const result = await collectProgress(fakeSource({
      readLog: async () => ({ text: '', error: 'EIO: i/o error' }),
      pid: async () => alphaPid(),
    }), fakeAgent(ALPHA))
    expect(result.text).toContain('read failed')
    expect(result.text).toContain('EIO')
  })

  it('caps every section and the whole block at the budget (P2)', async () => {
    const many = Array.from({ length: 300 }, (_unused, index) => todo({ id: `t${String(index)}`, text: `work item ${String(index)} ${'w'.repeat(300)}` }))
    const logs = Array.from({ length: 300 }, (_unused, index) => `- log ${String(index)} ${'l'.repeat(400)}`).join('\n')
    const entries = Array.from({ length: 40 }, (_unused, index) => entry({ id: `e${String(index)}`, content: `entry ${String(index)} ${'e'.repeat(400)}` }))
    const result = await collectProgress(fakeSource({
      listTodos: async () => many,
      readLog: async () => ({ text: logs }),
      listEntries: async () => entries,
      pid: async () => alphaPid(),
    }), fakeAgent(ALPHA))
    expect(result.text.length).toBeLessThanOrEqual(PROGRESS_BUDGET_CHARS)
    expect(result.omitted).toBeGreaterThan(0)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('report truncated')
    expect(result.text.startsWith(INJECT_LABEL)).toBe(true)
  })

  it('honours a smaller budget without ever dropping the label', async () => {
    const result = renderProgress({
      label: INJECT_LABEL,
      today: '2026-03-04',
      todos: [todo({})],
      logs: [{ scope: 'daily', text: '- note' }],
      entries: [],
      budget: 60,
    })
    expect(result.text).toBe('')
    expect(result.truncated).toBe(true)
  })

  it('lists at most 8 entries and 3 log days by contract', () => {
    expect(PROGRESS_ENTRY_LIMIT).toBe(8)
    expect(PROGRESS_LOG_DAYS).toBe(3)
    expect(PROGRESS_BUDGET_CHARS).toBe(4000)
    expect(progressHeader(2, 1, 'abcdef123456')).toContain('2 open todo(s)')
  })

  it('neutralises brace pairs in stored content at the render edge (P9)', async () => {
    const result = await collectProgress(fakeSource({
      listTodos: async () => [todo({ text: 'wire {{session}} through' })],
      readLog: async () => ({ text: '- {{user}} leaked }} here' }),
      listEntries: async () => [entry({ content: 'see {{config}} now' })],
      pid: async () => alphaPid(),
    }), fakeAgent(ALPHA))
    expect(result.text).not.toContain('{{')
    expect(result.text).not.toContain('}}')
    expect(result.text).toContain(neutralize('- {{user}} leaked }} here'))
  })
})

describe('cortex_progress_report against the real store', () => {
  it('is one registered tool, read-only, and reports the state as stored', async () => {
    expect(PROGRESS_TOOLS).toEqual(['cortex_progress_report'])
    const result = await runTool(harness.fake, 'cortex_progress_report', {}, fakeAgent(ALPHA))
    expect(result.status).toBe('ok')
    expect(String(result.report)).toContain('nothing summarised automatically')
    expect(Number(result.chars)).toBeLessThanOrEqual(PROGRESS_BUDGET_CHARS)
  })

  it('shows real todos and log lines once they exist', async () => {
    const todoResult = await harness.store.addTodo({ track: 'project', pid: alphaPid(), text: 'finish the M3 gate', due: '2026-03-02' })
    expect(todoResult.ok).toBe(true)
    await harness.store.logAppend({ scope: 'project', pid: alphaPid(), text: 'wired the progress report' })
    await harness.store.addEntry({ scope: { track: 'project', pid: alphaPid() }, content: 'reports are composed, never summarised' })
    const report = await progress.report(fakeAgent(ALPHA))
    expect(report.text).toContain('finish the M3 gate')
    expect(report.text).toContain('OVERDUE')
    expect(report.text).toContain('wired the progress report')
    expect(report.text).toContain('reports are composed, never summarised')
    const toolCall = await runTool(harness.fake, 'cortex_progress_report', {}, fakeAgent(ALPHA))
    expect(String(toolCall.report)).toContain('finish the M3 gate')
    expect(Number(toolCall.chars)).toBe(report.text.length)
  })

  it('a session outside any repo still gets a report, from the daily scope only', async () => {
    await harness.store.logAppend({ scope: 'daily', text: 'cross-project note' })
    const report = await progress.report(fakeAgent(undefined))
    expect(report.text).toContain('cross-project note')
    expect(report.text).not.toContain('### log (project')
  })

  it('does not mutate anything: a report is a read', async () => {
    const before = JSON.stringify((await harness.store.statusSnapshot()).data)
    await runTool(harness.fake, 'cortex_progress_report', {}, fakeAgent(ALPHA))
    expect(JSON.stringify((await harness.store.statusSnapshot()).data)).toBe(before)
  })
})
