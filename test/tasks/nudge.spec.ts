import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NUDGE_CONTEXT_NAME, NUDGE_CONTEXT_ORDER, TurnNudge, everyTurnsOf, nudgeLine,
} from '../../src/host/modules/logs/nudge.ts'
import { LogService } from '../../src/host/modules/logs/service.ts'
import { logTools } from '../../src/host/modules/logs/tools.ts'
import { INJECT_LABEL } from '../../src/host/config.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ALPHA, fakeAgent, makeHarness, renderContext, runTool } from './helpers.ts'
import type { Harness } from './helpers.ts'

/**
 * DESIGN §9.1 G-06: the program never pretends to summarise. It counts turns
 * and ASKS the AI to record what happened — once, with an honest label, and
 * never while the switch is off (default 0).
 */

let harness: Harness
let svc: LogService

beforeEach(async () => {
  harness = await makeHarness({ now: new Date('2026-03-04T05:06:07.000Z') })
  svc = new LogService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
  svc.install()
  for (const definition of logTools(svc)) harness.fake.ctx.tools.register(definition)
})

afterEach(async () => {
  svc.dispose()
  await harness.cleanup()
})

describe('everyTurns switch', () => {
  it('is off by default and reads the live config each time', () => {
    expect(everyTurnsOf(harness.config)).toBe(0)
    expect(svc.everyTurns).toBe(0)
    harness.config.logReview = { everyTurns: 4 }
    expect(svc.everyTurns).toBe(4)
    harness.config.logReview = { everyTurns: -3 }
    expect(everyTurnsOf(harness.config)).toBe(0)
    harness.config.logReview = { everyTurns: Number.NaN }
    expect(everyTurnsOf(harness.config)).toBe(0)
    delete harness.config.logReview
    expect(everyTurnsOf(harness.config)).toBe(0)
  })
})

describe('TurnNudge counter', () => {
  it('arms exactly at N, then starts counting again', () => {
    const nudge = new TurnNudge(() => 3)
    expect(nudge.countTurn('s1')).toBe(0)
    expect(nudge.countTurn('s1')).toBe(0)
    expect(nudge.turnsOf('s1')).toBe(2)
    expect(nudge.countTurn('s1')).toBe(3)
    expect(nudge.pending('s1')).toBe(true)
    expect(nudge.turnsOf('s1')).toBe(0)
    expect(nudge.countTurn('s1')).toBe(0)
  })

  it('counts sessions separately and stays silent while disabled', () => {
    const nudge = new TurnNudge(() => 0)
    for (let index = 0; index < 50; index += 1) expect(nudge.countTurn('s1')).toBe(0)
    expect(nudge.pending('s1')).toBe(false)
    expect(nudge.enabled).toBe(false)
    const live = new TurnNudge(() => 2)
    live.countTurn('a')
    expect(live.countTurn('b')).toBe(0)
    expect(live.pending('a')).toBe(false)
    live.countTurn('a')
    expect(live.pending('a')).toBe(true)
    expect(live.pending('b')).toBe(false)
  })

  it('the line says it is asking the AI, and that nothing was logged', () => {
    const line = nudgeLine(5)
    expect(line).toContain('AI diminta mencatat')
    expect(line).toContain('cortex_log_append')
    expect(line).toContain('Nothing has been logged automatically')
    expect(line).toContain('5 turns')
    expect(line).not.toContain('{{')
  })

  it('takes are one-shot', () => {
    const nudge = new TurnNudge(() => 1)
    expect(nudge.countTurn('s1')).toBe(1)
    const first = nudge.take('s1')
    expect(first).toContain('AI diminta mencatat')
    expect(nudge.take('s1')).toBe('')
    expect(nudge.take(undefined)).toBe('')
    expect(nudge.take('')).toBe('')
  })

  it('a log line settles the debt and cancels a pending reminder', () => {
    const nudge = new TurnNudge(() => 2)
    nudge.countTurn('s1')
    nudge.noteLogged('s1')
    expect(nudge.turnsOf('s1')).toBe(0)
    expect(nudge.countTurn('s1')).toBe(0)
    nudge.countTurn('s1')
    expect(nudge.pending('s1')).toBe(true)
    nudge.noteLogged('s1')
    expect(nudge.pending('s1')).toBe(false)
    expect(nudge.take('s1')).toBe('')
  })

  it('bounds its own memory across many sessions', () => {
    const nudge = new TurnNudge(() => 2, 4)
    for (const id of ['a', 'b', 'c', 'd', 'e']) nudge.countTurn(id)
    expect(nudge.pending('a')).toBe(false)
    nudge.countTurn('f')
    expect(nudge.turnsOf('f')).toBe(1)
  })
})

describe('the injected reminder', () => {
  it('never appears while the switch is off', () => {
    expect(harness.fake.contexts.map(row => row.name)).toEqual([NUDGE_CONTEXT_NAME])
    for (let index = 0; index < 20; index += 1) harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    expect(renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent: fakeAgent(ALPHA, 's1') })).toBe('')
  })

  it('fires at N, once, with the honest label on top', async () => {
    harness.config.logReview = { everyTurns: 3 }
    const agent = fakeAgent(ALPHA, 's1')
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    expect(renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent })).toBe('')
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    const block = renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent })
    expect(block.startsWith(`${INJECT_LABEL}\n`)).toBe(true)
    expect(block).toContain('AI diminta mencatat')
    // One shot: the turn after it must be silent again.
    expect(renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent })).toBe('')
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    expect(renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent })).toBe('')
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    expect(renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent })).toContain('AI diminta mencatat')
    await Promise.resolve()
  })

  it('ignores other event types and events without a session id', () => {
    harness.config.logReview = { everyTurns: 2 }
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/start' })
    harness.fake.emit('session/event', { id: 's1' }, { type: 'tool/result' })
    harness.fake.emit('session/event', {}, { type: 'turn/end' })
    expect(svc.nudge.turnsOf('s1')).toBe(0)
    harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
    expect(svc.nudge.turnsOf('s1')).toBe(1)
  })

  it('does not nag after the AI actually logs', async () => {
    harness.config.logReview = { everyTurns: 2 }
    const agent = fakeAgent(ALPHA, 's9')
    await runTool(harness.fake, 'cortex_log_append', { scope: 'daily', text: 'recorded the thing' }, agent)
    harness.fake.emit('session/event', { id: 's9' }, { type: 'turn/end' })
    expect(renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent })).toBe('')
    harness.fake.emit('session/event', { id: 's9' }, { type: 'turn/end' })
    expect(renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent })).toContain('AI diminta mencatat')
    expect(await readFile(join(harness.root, 'daily', '2026-03-04.md'), 'utf8')).toContain('recorded the thing')
  })

  it('is a reminder only: nothing was written to the log by the counter', async () => {
    harness.config.logReview = { everyTurns: 1 }
    for (let index = 0; index < 6; index += 1) {
      harness.fake.emit('session/event', { id: 's1' }, { type: 'turn/end' })
      renderContext(harness.fake, NUDGE_CONTEXT_NAME, { agent: fakeAgent(ALPHA, 's1') })
    }
    let exists = true
    try {
      await readFile(join(harness.root, 'daily', '2026-03-04.md'), 'utf8')
    } catch {
      exists = false
    }
    expect(exists, 'the nudge must not create log content by itself').toBe(false)
  })

  it('registers the seam at its own name and order, and stays clear of cortex:todo', () => {
    expect(NUDGE_CONTEXT_NAME).toBe('cortex:logs')
    expect(NUDGE_CONTEXT_ORDER).toBe(44)
    expect(harness.fake.contexts.map(row => row.name)).toEqual(['cortex:logs'])
  })

  it('survives a host that refuses the registration', async () => {
    const guarded = await makeHarness()
    try {
      guarded.fake.ctx.get = ((name: string) => (name === 'systemPrompt'
        ? { context: () => { throw new Error('duplicate') } }
        : undefined)) as never
      const guardedService = new LogService({ deps: guarded.deps, scopes: guarded.scopes })
      expect(() => guardedService.install()).not.toThrow()
      expect(guardedService.hasContextSeam).toBe(false)
      expect(guarded.warnings.join('\n')).toContain('context registration refused')
      guardedService.dispose()
    } finally {
      await guarded.cleanup()
    }
  })
})
