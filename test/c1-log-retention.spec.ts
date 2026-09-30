/**
 * C1 regression: `retention.dailyLogDays` is wired, not decorative.
 *
 * Before this PR the key was declared, surfaced by the status module, and
 * applied by nothing — log directories grew without bound. Pruning runs through
 * the store's write gate (so a newer-schema state root is never touched),
 * removes whole day files older than the window together with their rollover
 * parts, is idempotent, and leaves anything it does not recognise alone.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore, SCHEMA_VERSION } from '../src/host/store.ts'
import { DEFAULT_CAPS } from '../src/lib/caps.ts'
import { isoDate, shiftDate } from '../src/lib/ids.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

let root = ''
let warnings: string[] = []
const today = '2026-03-04'
const pid = 'c'.repeat(16)

function makeStore(now: () => Date = () => new Date(`${today}T05:06:07.000Z`)): CortexStore {
  return new CortexStore({ root, caps: DEFAULT_CAPS, warn: message => warnings.push(message), now })
}

/** One file per day for `days` days back from `endDay`, plus a rollover part on the oldest. */
async function seedDaily(days: number, endDay: string): Promise<void> {
  const dir = join(root, 'daily')
  await mkdir(dir, { recursive: true })
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = shiftDate(endDay, -i)
    await writeFile(join(dir, `${day}.md`), `- ${day}\n`, 'utf8')
    if (i === days - 1) await writeFile(join(dir, `${day}-2.md`), `- ${day} rolled\n`, 'utf8')
  }
}

beforeEach(async () => {
  root = await makeTempRoot('dsh-cortex-c1-retention-')
  warnings = []
  const store = makeStore()
  expect((await store.init()).ok).toBe(true)
})
afterEach(async () => { await removeTempRoot(root) })

describe('pruneLogs', () => {
  it('removes days outside the window and keeps the newest days', async () => {
    await seedDaily(120, today)
    const store = makeStore()
    const result = await store.pruneLogs({ days: 90, scope: 'daily' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Oldest 30 days plus that day's rollover part are gone.
    expect(result.data.removed).toHaveLength(31)
    const kept = await store.logRead({ scope: 'daily', date: today, lastDays: 1 })
    expect(kept.ok && kept.data.text).toContain(today)
    const justInside = await store.logRead({ scope: 'daily', date: shiftDate(today, -89) })
    expect(justInside.ok && justInside.data.text.length).toBeGreaterThan(0)
    const justOutside = await store.logRead({ scope: 'daily', date: shiftDate(today, -90) })
    expect(justOutside.ok && justOutside.data.text).toBe('')
  })

  it('is idempotent', async () => {
    await seedDaily(120, today)
    const store = makeStore()
    const first = await store.pruneLogs({ days: 90, scope: 'daily' })
    const second = await store.pruneLogs({ days: 90, scope: 'daily' })
    expect(first.ok && first.data.removed.length).toBeGreaterThan(0)
    expect(second.ok && second.data.removed).toEqual([])
  })

  it('leaves files it does not recognise', async () => {
    await seedDaily(120, today)
    await writeFile(join(root, 'daily', 'notes.md'), 'stray\n', 'utf8')
    await writeFile(join(root, 'daily', '.hidden.md'), 'dot\n', 'utf8')
    const store = makeStore()
    await store.pruneLogs({ days: 90, scope: 'daily' })
    const notes = await store.logRead({ scope: 'daily', date: today })
    expect(notes.ok).toBe(true)
    // notes.md is not a date part, so it never appears in a day read…
    expect(notes.ok && notes.data.text).not.toContain('stray')
    // …and a second prune does not report it as removed either.
    const again = await store.pruneLogs({ days: 90, scope: 'daily' })
    expect(again.ok && again.data.removed).toEqual([])
  })

  it('prunes a project log directory in isolation', async () => {
    const dir = join(root, 'projects', pid, 'log')
    await mkdir(dir, { recursive: true })
    for (let i = 0; i < 120; i += 1) {
      const day = shiftDate(today, -i)
      await writeFile(join(dir, `${day}.md`), `- ${day}\n`, 'utf8')
    }
    await seedDaily(120, today)
    const store = makeStore()
    const result = await store.pruneLogs({ days: 90, scope: 'project', pid })
    expect(result.ok && result.data.removed).toHaveLength(30)
    const dailyUntouched = await store.logRead({ scope: 'daily', date: shiftDate(today, -100) })
    expect(dailyUntouched.ok && dailyUntouched.data.text.length).toBeGreaterThan(0)
  })

  it('refuses a project prune without a pid and reports it as an envelope', async () => {
    const store = makeStore()
    const result = await store.pruneLogs({ days: 90, scope: 'project' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('project logs need a project id')
  })

  it('never prunes a state root written by a newer schema', async () => {
    await seedDaily(120, today)
    await writeFile(join(root, 'schema.json'), JSON.stringify({ version: SCHEMA_VERSION + 1 }), 'utf8')
    const store = makeStore()
    const result = await store.pruneLogs({ days: 1, scope: 'daily' })
    expect(result.ok).toBe(false)
    const stillThere = await store.logRead({ scope: 'daily', date: shiftDate(today, -100) })
    expect(stillThere.ok && stillThere.data.text.length).toBeGreaterThan(0)
  })

  it('clamps a nonsense window instead of deleting everything', async () => {
    await seedDaily(10, today)
    const store = makeStore()
    const zero = await store.pruneLogs({ days: 0, scope: 'daily' })
    expect(zero.ok && zero.data.removed).toEqual([])
    const negative = await store.pruneLogs({ days: -5, scope: 'daily' })
    expect(negative.ok && negative.data.removed).toEqual([])
    const todayStill = await store.logRead({ scope: 'daily', date: isoDate(new Date(`${today}T05:06:07.000Z`)) })
    expect(todayStill.ok && todayStill.data.text.length).toBeGreaterThan(0)
  })

  it('keeps a rollback file removal honest through the warn sink', async () => {
    await seedDaily(120, today)
    const store = makeStore()
    await store.pruneLogs({ days: 90, scope: 'daily' })
    expect(warnings.filter(message => message.startsWith('pruneLogs'))).toEqual([])
  })
})
