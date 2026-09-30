/**
 * C1 regression: `logRead` must answer a day that is NEWER than the rest of its
 * directory.
 *
 * Defect (reproduced before the fix): `logRead` listed the log directory once
 * per requested day through the capped `listDir`, which keeps the OLDEST `cap`
 * names. A daily log holding more than 40 files therefore answered `""` for
 * today's date even though today's file existed on disk — `cortex_log_read`,
 * the progress report, the handoff block and decision indexing all went
 * silently empty.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore } from '../src/host/store.ts'
import { DEFAULT_CAPS } from '../src/lib/caps.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

let root = ''
let store: CortexStore
const pid = 'b'.repeat(16)

/** `days` consecutive day files ending at (and including) `endDay`. */
async function seedDays(dir: string, days: number, endDay: string, line: (day: string) => string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const end = new Date(`${endDay}T00:00:00.000Z`)
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - i)
    const day = date.toISOString().slice(0, 10)
    await writeFile(join(dir, `${day}.md`), `${line(day)}\n`, 'utf8')
  }
}

beforeEach(async () => {
  root = await makeTempRoot('dsh-cortex-c1-logread-')
  store = new CortexStore({ root, caps: DEFAULT_CAPS, warn: () => {} })
  expect((await store.init()).ok).toBe(true)
})
afterEach(async () => { await removeTempRoot(root) })

describe('logRead over a log directory with more files than a page', () => {
  it('returns the newest day when the directory holds 61 files', async () => {
    const dir = join(root, 'daily')
    await seedDays(dir, 61, '2026-03-01', day => `- line for ${day}`)
    const read = await store.logRead({ scope: 'daily', date: '2026-03-01' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.text).toContain('line for 2026-03-01')
  })

  it('sees a line appended today even after 60 older day files exist', async () => {
    const dir = join(root, 'daily')
    await seedDays(dir, 60, '2026-03-01', day => `- line for ${day}`)
    const appended = await store.logAppend({ scope: 'daily', text: 'FRESH LINE right now' })
    expect(appended.ok).toBe(true)
    if (!appended.ok) return
    const read = await store.logRead({ scope: 'daily', date: appended.data.date })
    expect(read.ok && read.data.text).toContain('FRESH LINE right now')
  })

  it('returns every requested day across the window, newest first', async () => {
    const dir = join(root, 'daily')
    await seedDays(dir, 61, '2026-03-01', day => `- line for ${day}`)
    const read = await store.logRead({ scope: 'daily', date: '2026-03-01', lastDays: 3 })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.days).toEqual(['2026-03-01', '2026-02-28', '2026-02-27'])
    expect(read.data.text).toContain('line for 2026-03-01')
    expect(read.data.text).toContain('line for 2026-02-28')
    expect(read.data.text).toContain('line for 2026-02-27')
  })

  it('includes rollover parts (-2.md) of the requested day', async () => {
    const dir = join(root, 'daily')
    await seedDays(dir, 61, '2026-03-01', day => `- line for ${day}`)
    await writeFile(join(dir, '2026-03-01-2.md'), '- rolled over content\n', 'utf8')
    const read = await store.logRead({ scope: 'daily', date: '2026-03-01' })
    expect(read.ok && read.data.text).toContain('rolled over content')
    expect(read.ok && read.data.text).toContain('line for 2026-03-01')
  })

  it('ignores files that are not date-named log parts', async () => {
    const dir = join(root, 'daily')
    await seedDays(dir, 61, '2026-03-01', day => `- line for ${day}`)
    await writeFile(join(dir, 'notes.md'), '- a stray note\n', 'utf8')
    const read = await store.logRead({ scope: 'daily', date: '2026-03-01' })
    expect(read.ok && read.data.text).not.toContain('a stray note')
  })

  it('reads a project log past the same wall and stays empty without a pid', async () => {
    const dir = join(root, 'projects', pid, 'log')
    await seedDays(dir, 61, '2026-03-01', day => `- project line for ${day}`)
    const read = await store.logRead({ scope: 'project', pid, date: '2026-03-01' })
    expect(read.ok && read.data.text).toContain('project line for 2026-03-01')
    const noPid = await store.logRead({ scope: 'project', date: '2026-03-01' })
    expect(noPid.ok && noPid.data.text).toBe('')
  })
})
