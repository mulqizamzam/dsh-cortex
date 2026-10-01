import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M2 GUARD: `logRead` lists its log directory ONCE per read, whatever the
 * window. The per-day re-listing was the shape C1 removed together with the
 * capped page (commit d85bcf1): the old loop asked the directory once per
 * requested day. Nothing else in `src/` lists per day.
 *
 * So this file changes no source. It pins the property at the syscall level
 * (a wrapped `readdir` counter, which is what "re-lists per day" means), and
 * it measures the old strategy against the shipped one by re-running the old
 * strategy here against the same directory.
 */

const readdirCount = vi.hoisted(() => ({ value: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = ((...args: Parameters<typeof actual.readdir>) => {
    readdirCount.value += 1
    return actual.readdir(...args)
  }) as typeof actual.readdir
  return { ...actual, readdir, default: { ...actual, readdir } }
})

const { CortexStore } = await import('../src/host/store.ts')
const { listDir } = await import('../src/lib/fsx.ts')
const { shiftDate } = await import('../src/lib/ids.ts')
const { DEFAULT_CAPS } = await import('../src/lib/caps.ts')
type Store = InstanceType<typeof CortexStore>

let root = ''
let store: Store

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-m2-'))
  store = new CortexStore({ root })
  await store.init()
  readdirCount.value = 0
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

/** `days` consecutive day files ending at `endDay`, one line each. */
async function seedDays(days: number, endDay: string, linesPerDay = 1): Promise<string> {
  const dir = join(root, 'daily')
  await mkdir(dir, { recursive: true })
  const end = new Date(`${endDay}T00:00:00.000Z`)
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - index)
    const day = date.toISOString().slice(0, 10)
    await writeFile(join(dir, `${day}.md`), Array.from({ length: linesPerDay }, (_, line) => `- ${day} line ${String(line)}`).join('\n'), 'utf8')
  }
  return dir
}

/**
 * The pre-C1 listing strategy, re-implemented here: list the directory once per
 * requested day through the capped `listDir` (oldest `cap` names), then join
 * exactly like the shipped reader joins. Everything except the listing call is
 * the current code's shape.
 */
async function legacyPerDayRead(dir: string, base: string, window: number, searchResultChars: number): Promise<string> {
  const parts: string[] = []
  for (let index = 0; index < window; index += 1) {
    const day = shiftDate(base, -index)
    const { names } = await listDir(dir, 40)
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      if (!name.startsWith(day)) continue
      const { readTextSafe } = await import('../src/lib/fsx.ts')
      const text = await readTextSafe(join(dir, name), () => {})
      if (text) parts.push(`### ${day} (${name})\n${text.trimEnd()}`)
    }
  }
  const joined = parts.join('\n\n')
  return joined.length > searchResultChars ? `${joined.slice(0, searchResultChars)}\n[… truncated]` : joined
}

describe('M2: logRead lists its directory once per read', () => {
  it('one readdir for a 61-file directory, whatever the window is', async () => {
    await seedDays(61, '2026-09-30')
    readdirCount.value = 0
    const wide = await store.logRead({ scope: 'daily', date: '2026-09-30', lastDays: 90 })
    expect(wide.ok).toBe(true)
    const wideCalls = readdirCount.value
    expect(wideCalls, 'a 90-day window must not list the directory 90 times').toBe(1)

    readdirCount.value = 0
    const narrow = await store.logRead({ scope: 'daily', date: '2026-09-30', lastDays: 1 })
    expect(narrow.ok).toBe(true)
    expect(readdirCount.value).toBe(1)
    expect(wideCalls).toBe(readdirCount.value)
  })

  it('produces byte-identical output to the old per-day strategy where both can see the files', async () => {
    const dir = await seedDays(30, '2026-09-30', 3)
    const current = await store.logRead({ scope: 'daily', date: '2026-09-30', lastDays: 30 })
    expect(current.ok).toBe(true)
    const data = current.data
    if (data === undefined) throw new Error('logRead returned no data')
    const legacy = await legacyPerDayRead(dir, '2026-09-30', 30, DEFAULT_CAPS.searchResultChars)
    expect(data.text).toBe(legacy)
    expect(data.days).toHaveLength(30)
  })

  it('the old strategy costs one listing per day; the shipped one costs one, measured', async () => {
    const dir = await seedDays(61, '2026-09-30', 3)

    readdirCount.value = 0
    const legacyStart = performance.now()
    const legacyText = await legacyPerDayRead(dir, '2026-09-30', 90, DEFAULT_CAPS.searchResultChars)
    const legacyMs = performance.now() - legacyStart
    const legacyCalls = readdirCount.value

    readdirCount.value = 0
    const shippedStart = performance.now()
    const shipped = await store.logRead({ scope: 'daily', date: '2026-09-30', lastDays: 90 })
    const shippedMs = performance.now() - shippedStart
    const shippedCalls = readdirCount.value

    console.log(`BENCH logRead 90-day window over 61 day files: old per-day strategy ${legacyMs.toFixed(1)} ms / ${String(legacyCalls)} readdir calls, shipped ${shippedMs.toFixed(1)} ms / ${String(shippedCalls)} readdir call`)
    expect(shipped.ok).toBe(true)
    expect(shippedCalls).toBe(1)
    // The old strategy could not even reach the newest day through the cap.
    expect(legacyText).not.toContain('2026-09-30')
    const shippedData = shipped.data
    if (shippedData === undefined) throw new Error('logRead returned no data')
    expect(shippedData.text).toContain('2026-09-30')
  })
})
