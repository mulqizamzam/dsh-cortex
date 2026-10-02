/**
 * §2.4 — store.listEntries must clamp caller-supplied limit to LIST_CAP.
 *
 * Tool layer (memory/ops.ts) already hard-clamps the RPC argument, but
 * listEntries is public and also called directly by delegate/service,
 * decisions/service, and memory/render. Any caller that bypasses the tool
 * layer (e.g. a future internal caller) must not be able to force the
 * store to readdir far beyond LIST_CAP names.
 *
 * Verdict: hard cap at LIST_CAP, regardless of what the filter passes.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore, LIST_CAP, clampListLimit } from '../../src/host/store.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'

let root = ''
let warnings: string[] = []
let clock = new Date('2026-03-04T05:06:07.000Z')

function makeStore(): CortexStore {
  return new CortexStore({
    root,
    caps: DEFAULT_CAPS,
    warn: message => warnings.push(message),
    now: () => clock,
  })
}

beforeEach(async () => {
  root = await makeTempRoot('dsh-cortex-store-limit-')
  warnings = []
  clock = new Date('2026-03-04T05:06:07.000Z')
})
afterEach(async () => { await removeTempRoot(root) })

async function seedEntries(dir: string, count: number): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (let i = 0; i < count; i++) {
    const id = `mem-${String(i).padStart(4, '0')}`
    const entry = {
      id,
      content: `entry ${i}`,
      importance: 3,
      createdAt: '2026-03-04T05:06:07.000Z',
      updatedAt: '2026-03-04T05:06:07.000Z',
      track: 'global',
      tags: [],
      branches: [],
    }
    await writeFile(join(dir, `${id}.json`), JSON.stringify(entry), 'utf8')
  }
}

describe('listEntries limit clamp', () => {
  it('hard-clamps an oversized limit to LIST_CAP', async () => {
    const store = makeStore()
    expect(await store.init()).toHaveProperty('ok', true)

    const dir = join(root, 'global', 'entries')
    await seedEntries(dir, 600)

    const result = await store.listEntries({ track: 'global', limit: 1_000_000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.entries.length).toBeLessThanOrEqual(LIST_CAP)
    // Because 600 > LIST_CAP, truncation flag must be true.
    expect(result.data.truncated).toBe(true)
  })

  it('honours a limit below LIST_CAP even when the directory exceeds it', async () => {
    // 10 entries, limit=5: readdir returns 5 names, page.truncated=true,
    // ordered.slice(0, limit) returns 5 entries, truncated flag stays true.
    const store = makeStore()
    expect(await store.init()).toHaveProperty('ok', true)

    const dir = join(root, 'global', 'entries')
    await seedEntries(dir, 10)

    const result = await store.listEntries({ track: 'global', limit: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.entries.length).toBe(5)
    expect(result.data.truncated).toBe(true)
  })

  it('returns all entries without truncation when count fits below limit', async () => {
    const store = makeStore()
    expect(await store.init()).toHaveProperty('ok', true)

    const dir = join(root, 'global', 'entries')
    await seedEntries(dir, 3)

    const result = await store.listEntries({ track: 'global', limit: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.entries.length).toBe(3)
    expect(result.data.truncated).toBe(false)
  })

  it('uses LIST_CAP as the effective limit when no limit is supplied', async () => {
    const store = makeStore()
    expect(await store.init()).toHaveProperty('ok', true)

    const dir = join(root, 'global', 'entries')
    await seedEntries(dir, LIST_CAP + 50)

    const result = await store.listEntries({ track: 'global' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.entries.length).toBe(LIST_CAP)
    expect(result.data.truncated).toBe(true)
  })
})

describe('clampListLimit', () => {
  it('caps large values to LIST_CAP', () => {
    expect(clampListLimit(1_000_000)).toBe(LIST_CAP)
    expect(clampListLimit(LIST_CAP + 1)).toBe(LIST_CAP)
  })
  it('returns the requested value when within [1, LIST_CAP]', () => {
    expect(clampListLimit(5)).toBe(5)
    expect(clampListLimit(LIST_CAP)).toBe(LIST_CAP)
  })
  it('returns LIST_CAP when limit is undefined', () => {
    expect(clampListLimit(undefined)).toBe(LIST_CAP)
  })
  it('clips NaN/Infinity to LIST_CAP', () => {
    expect(clampListLimit(NaN)).toBe(LIST_CAP)
    expect(clampListLimit(Infinity)).toBe(LIST_CAP)
    expect(clampListLimit(-Infinity)).toBe(LIST_CAP)
  })
  it('clips zero and negative values to 1', () => {
    expect(clampListLimit(0)).toBe(1)
    expect(clampListLimit(-10)).toBe(1)
  })
})
