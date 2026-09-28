import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { LogService, READ_LINE_CHARS, READ_MAX_LINES, shapeLogText } from '../../src/host/modules/logs/service.ts'
import { logTools } from '../../src/host/modules/logs/tools.ts'
import { logsReadEndpoints } from '../../src/host/modules/logs/rpc.ts'
import { neutralize } from '../../src/lib/sanitize.ts'
import { ALPHA, BETA, alphaPid, callEndpoint, fakeAgent, makeHarness, runTool } from './helpers.ts'
import type { Harness } from './helpers.ts'

/** M3 acceptance: log caps (including the day-rollover marker) and bounded reads. */

let harness: Harness
let svc: LogService

beforeEach(async () => {
  harness = await makeHarness({ now: new Date('2026-03-04T05:06:07.000Z') })
  svc = new LogService({ deps: harness.deps, scopes: harness.scopes, now: () => harness.clock.value })
  for (const definition of logTools(svc)) harness.fake.ctx.tools.register(definition)
})

afterEach(async () => {
  svc.dispose()
  await harness.cleanup()
})

describe('cortex_log_append', () => {
  it('writes one line to the daily log and reports the day it landed on', async () => {
    const result = await runTool(harness.fake, 'cortex_log_append', { scope: 'daily', text: 'shipped the digest renderer' }, fakeAgent(ALPHA))
    expect(result.status).toBe('logged')
    expect(result.date).toBe('2026-03-04')
    expect(result.line).toBe('- shipped the digest renderer')
    expect(await readFile(join(harness.root, 'daily', '2026-03-04.md'), 'utf8')).toBe('- shipped the digest renderer\n')
  })

  it('files a project line under the session repo and not under another', async () => {
    await runTool(harness.fake, 'cortex_log_append', { scope: 'project', text: 'fixed the alpha build' }, fakeAgent(ALPHA))
    expect(await readFile(join(harness.root, 'projects', alphaPid(), 'log', '2026-03-04.md'), 'utf8')).toContain('fixed the alpha build')
    const inBeta = await svc.read({ scope: 'project', lastDays: 1 }, fakeAgent(BETA))
    expect(inBeta.ok).toBe(true)
    expect((inBeta.lines ?? []).join(' ')).not.toContain('fixed the alpha build')
    // The project directory is registered with its cwd, the way DESIGN §2 wants.
    expect(await readFile(join(harness.root, 'projects', alphaPid(), 'meta.json'), 'utf8')).toContain(ALPHA)
  })

  it('refuses a project line when the session has no usable scope', async () => {
    const result = await runTool(harness.fake, 'cortex_log_append', { scope: 'project', text: 'orphan line' }, fakeAgent(undefined))
    expect(result.status).toBe('refused')
    expect(String(result.message)).toContain('daily')
  })

  it('refuses an unknown scope and an empty line with sentences, not stacks', async () => {
    expect((await svc.append({ scope: 'weekly', text: 'x' }, undefined)).message).toContain('scope must be')
    expect((await svc.append({ scope: 'daily', text: '   ' }, undefined)).message).toContain('text is required')
  })

  it('clamps what lands in the file at caps.logLineChars (P2, write side)', async () => {
    const long = 'x'.repeat(DEFAULT_CAPS.logLineChars + 400)
    expect((await svc.append({ scope: 'daily', text: long }, undefined)).ok).toBe(true)
    const file = await readFile(join(harness.root, 'daily', '2026-03-04.md'), 'utf8')
    for (const line of file.split('\n').filter(Boolean)) {
      expect(line.length).toBeLessThanOrEqual(DEFAULT_CAPS.logLineChars)
      expect(line).toMatch(/…$/)
    }
  })

  it('marks the day rollover: a second file appears and the tool says so', async () => {
    harness.config.caps = { ...harness.config.caps, logDayChars: 120 }
    const refs = []
    for (let index = 0; index < 3; index += 1) {
      refs.push(await svc.append({ scope: 'daily', text: `entry ${String(index)} ${'y'.repeat(60)}` }, fakeAgent(ALPHA)))
    }
    expect(refs[0]?.ok).toBe(true)
    expect(refs[0]?.ref?.rolled, 'the first line stays in the day file').toBeUndefined()
    expect(refs[1]?.ref?.rolled).toBe(true)
    expect(refs[1]?.message).toContain('day file was full')
    expect(refs[2]?.ref?.rolled).toBe(true)
    const dir = join(harness.root, 'daily')
    expect(await readFile(join(dir, '2026-03-04.md'), 'utf8')).toContain('entry 0')
    expect(await readFile(join(dir, '2026-03-04-2.md'), 'utf8')).toContain('entry 1')
    expect(await readFile(join(dir, '2026-03-04-3.md'), 'utf8')).toContain('entry 2')
    // Every part of the day reads back, so nothing becomes invisible.
    const read = await svc.read({ scope: 'daily', lastDays: 1 }, undefined)
    expect([read.text ?? ''].join('')).toContain('entry 0')
    expect(read.text).toContain('entry 1')
    expect(read.text).toContain('entry 2')
  })

  it('a new calendar day starts a new file (rollover in time)', async () => {
    await svc.append({ scope: 'daily', text: 'tuesday work' }, undefined)
    harness.clock.value = new Date('2026-03-05T01:02:03.000Z')
    const next = await svc.append({ scope: 'daily', text: 'wednesday work' }, undefined)
    expect(next.ref?.date).toBe('2026-03-05')
    expect(await readFile(join(harness.root, 'daily', '2026-03-04.md'), 'utf8')).toContain('tuesday work')
    expect(await readFile(join(harness.root, 'daily', '2026-03-05.md'), 'utf8')).toContain('wednesday work')
    const two = await svc.read({ scope: 'daily', lastDays: 2 }, undefined)
    expect(two.days).toEqual(['2026-03-05', '2026-03-04'])
    expect(two.text).toContain('tuesday work')
    expect(two.text).toContain('wednesday work')
  })
})

describe('cortex_log_read', () => {
  beforeEach(async () => {
    for (const text of ['first thing', 'second thing', 'third thing']) {
      await svc.append({ scope: 'daily', text }, undefined)
    }
  })

  it('reads today by default and reports how much came back', async () => {
    const result = await runTool(harness.fake, 'cortex_log_read', { scope: 'daily' }, undefined)
    expect(result.status).toBe('ok')
    expect(String(result.text)).toContain('third thing')
    expect(result.days).toEqual(['2026-03-04'])
    expect(result.message).toContain('3 line(s)')
    expect(result.text).toContain('### 2026-03-04')
  })

  it('refuses a window wider than the contract, a bad date and a bad scope', async () => {
    const tooWide = await svc.read({ scope: 'daily', lastDays: 8 }, undefined)
    expect(tooWide.ok).toBe(false)
    expect(tooWide.message).toContain('capped at 7')
    expect((await svc.read({ scope: 'daily', date: '03/04/2026' }, undefined)).message).toContain('YYYY-MM-DD')
    expect((await svc.read({ scope: 'nope' }, undefined)).message).toContain('scope must be')
    expect((await svc.read({ scope: 'project' }, fakeAgent(undefined))).ok).toBe(false)
  })

  it('an empty day is reported as empty, never as a fabricated entry', async () => {
    const result = await svc.read({ scope: 'daily', date: '2020-01-01' }, undefined)
    expect(result.ok).toBe(true)
    expect(result.text).toBe('')
    expect(result.lines).toEqual([])
    expect(result.message).toContain('no daily log lines')
  })

  it('a huge day is bounded and says what it left out', async () => {
    const synthetic = Array.from({ length: READ_MAX_LINES + 25 }, (_unused, index) => `- line ${String(index)} ${'z'.repeat(600)}`).join('\n')
    const shaped = shapeLogText(synthetic)
    expect(shaped.lines).toHaveLength(READ_MAX_LINES)
    expect(shaped.text.split('\n')[0]).toContain('older line(s) omitted')
    expect(shaped.lines[READ_MAX_LINES - 1]).toContain('line 104')
    expect(shaped.lines[0].length).toBeLessThanOrEqual(READ_LINE_CHARS)
    // On a real file the store's own read ceiling bites first; that too is said.
    await writeFile(join(harness.root, 'daily', '2026-03-04-huge.md'), `${synthetic}\n`, 'utf8')
    const read = await svc.read({ scope: 'daily', lastDays: 1 }, undefined)
    const text = read.text ?? ''
    expect(text).toMatch(/truncated|older line\(s\) omitted/)
  })

  it('neutralises brace pairs a hand-edited file smuggles in (P9)', async () => {
    await writeFile(join(harness.root, 'daily', '2026-03-04.md'), '- {{session}} leaked and }} too\n', 'utf8')
    const read = await svc.read({ scope: 'daily' }, undefined)
    const text = read.text ?? ''
    expect(text).not.toContain('{{')
    expect(text).not.toContain('}}')
    expect(text).toContain(neutralize('- {{session}} leaked and }} too'))
  })

  it('shapeLogText keeps whole lines only', () => {
    expect(shapeLogText('')).toEqual({ lines: [], text: '', count: 0 })
    expect(shapeLogText('a\n\n  \nb  \n').lines).toEqual(['a', 'b'])
  })
})

describe('logs.read endpoint', () => {
  it('answers the frozen { date, text }[] shape, one row per day', async () => {
    await svc.append({ scope: 'daily', text: 'panel-visible line' }, undefined)
    const result = await callEndpoint(logsReadEndpoints(svc), 'logs.read', { scope: 'daily', lastDays: 3 })
    expect(result.ok).toBe(true)
    const value = result.value as { scope: string; days: Array<{ date: string; text: string; lines: number }> }
    expect(value.scope).toBe('daily')
    expect(value.days.map(row => row.date)).toEqual(['2026-03-04', '2026-03-03', '2026-03-02'])
    expect(value.days[0]?.text).toContain('panel-visible line')
    expect(value.days[1]?.text).toBe('')
    expect(value.days[1]?.lines).toBe(0)
  })

  it('validates payload types by hand and never throws at the transport', async () => {
    const map = logsReadEndpoints(svc)
    expect((await callEndpoint(map, 'logs.read', {})).error?.code).toBe('command-error') // projected; ours rides in the message
    expect((await callEndpoint(map, 'logs.read', null)).error?.code).toBe('command-error') // projected; ours rides in the message
    expect((await callEndpoint(map, 'logs.read', 'not-an-object')).error?.code).toBe('command-error') // projected; ours rides in the message
    expect((await callEndpoint(map, 'logs.read', { scope: 'project' })).error?.message).toContain('projectId')
    expect((await callEndpoint(map, 'logs.read', { scope: 'daily', lastDays: 99 })).error?.code).toBe('command-error') // projected; ours rides in the message
    expect((await callEndpoint(map, 'logs.read', { scope: 'daily', date: 'nope' })).error?.code).toBe('command-error') // projected; ours rides in the message
    expect((await callEndpoint(map, 'logs.read', { scope: 'daily', lastDays: 'three' })).error?.code).toBe('command-error') // projected; ours rides in the message
  })

  it('reads a project day back through the endpoint', async () => {
    await svc.append({ scope: 'project', text: 'project row for the panel' }, fakeAgent(ALPHA))
    const flat = await callEndpoint(logsReadEndpoints(svc), 'logs.read', { scope: 'project', lastDays: 2, projectId: alphaPid() })
    expect(flat.ok).toBe(true)
    expect(JSON.stringify(flat.value)).toContain('project row for the panel')
    // `scope` is the log target in this contract; a nested object is not a target.
    expect((await callEndpoint(logsReadEndpoints(svc), 'logs.read', { scope: { projectId: alphaPid() } })).error?.code).toBe('command-error') // projected; ours rides in the message
  })
})
