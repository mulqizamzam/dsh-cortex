/**
 * C1 regression: `readMessages` must reach the NEWEST messages of a room.
 *
 * Defect (reproduced before the fix): it took the oldest `LIST_CAP` (500) names
 * from the message directory, opened and parsed every one, and only then
 * applied `sinceSeq`. With 600 messages on disk, `readMessages(limit: 5)`
 * answered seq 496-500 and `sinceSeq: 550` answered nothing at all — room
 * history froze at message 500 and the mail ledger could never advance.
 *
 * The seq is already in the file name, so the page is chosen from the names and
 * only the files that can be returned are opened. The selection is numeric,
 * because zero-padding stops ordering correctly past 999999.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore } from '../src/host/store.ts'
import { DEFAULT_CAPS } from '../src/lib/caps.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

let root = ''
let store: CortexStore
const roomId = 'r1'

async function seedMessages(count: number, start = 1): Promise<void> {
  const dir = join(root, 'rooms', roomId, 'messages')
  await mkdir(dir, { recursive: true })
  for (let seq = start; seq < start + count; seq += 1) {
    await writeFile(
      join(dir, `${String(seq).padStart(6, '0')}.json`),
      JSON.stringify({ seq, roomId, text: `m${seq}`, at: '2026-01-01T00:00:00.000Z', fromKind: 'session' }, null, 2),
      'utf8',
    )
  }
}

beforeEach(async () => {
  root = await makeTempRoot('dsh-cortex-c1-messages-')
  store = new CortexStore({ root, caps: DEFAULT_CAPS, warn: () => {} })
  expect((await store.init()).ok).toBe(true)
  const room = await store.createRoom({ title: 'bench' })
  expect(room.ok).toBe(true)
})
afterEach(async () => { await removeTempRoot(root) })

describe('readMessages past the listing cap', () => {
  it('returns the newest page of a 600-message room', async () => {
    await seedMessages(600)
    const page = await store.readMessages(roomId, { limit: 5 })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.data.map(message => message.seq)).toEqual([596, 597, 598, 599, 600])
    expect(page.data.at(-1)?.text).toBe('m600')
  })

  it('returns everything newer than sinceSeq', async () => {
    await seedMessages(600)
    const page = await store.readMessages(roomId, { sinceSeq: 550, limit: 50 })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.data.map(message => message.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => 551 + index),
    )
  })

  it('returns [] when sinceSeq is at or beyond the newest message', async () => {
    await seedMessages(600)
    const atNewest = await store.readMessages(roomId, { sinceSeq: 600 })
    const beyond = await store.readMessages(roomId, { sinceSeq: 999 })
    expect(atNewest.ok && atNewest.data).toEqual([])
    expect(beyond.ok && beyond.data).toEqual([])
  })

  it('orders numerically, not lexicographically, past 999999', async () => {
    const dir = join(root, 'rooms', roomId, 'messages')
    await mkdir(dir, { recursive: true })
    for (const seq of [999999, 1000000, 1000001]) {
      await writeFile(
        join(dir, `${String(seq).padStart(6, '0')}.json`),
        JSON.stringify({ seq, roomId, text: `m${seq}`, at: '2026-01-01T00:00:00.000Z', fromKind: 'session' }, null, 2),
        'utf8',
      )
    }
    const page = await store.readMessages(roomId, { limit: 2 })
    expect(page.ok && page.data.map(message => message.seq)).toEqual([1000000, 1000001])
  })

  it('still honours the default limit and small rooms', async () => {
    await seedMessages(7)
    const page = await store.readMessages(roomId)
    expect(page.ok && page.data.map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
