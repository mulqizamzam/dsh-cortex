/**
 * `rooms.leave` is a read-modify-write on `rooms/<id>/room.json` performed by
 * the MODULE, not the store: it reads the room through `get()`, filters the
 * member list, then writes the whole document back through `writeStateJson`.
 * The store gate serializes the write but cannot see the read, so a join that
 * lands in between is erased by the stale snapshot that follows.
 *
 * Remove is the same defect class as the store's own read-modify-write paths
 * (see test/store/lost-update.spec.ts); it just lives one layer up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply as applyRooms } from '../../src/host/modules/rooms/index.ts'
import { makeHarness } from './helpers.ts'
import type { Harness } from './helpers.ts'

let harness: Harness

beforeEach(async () => {
  harness = await makeHarness({ agents: [] })
  applyRooms(harness.deps)
})

afterEach(async () => {
  await harness.dispose()
})

describe('rooms.leave loses a concurrent removal', () => {
  it('removes every member when 20 leaves overlap', async () => {
    const created = await harness.rooms.create({ title: 'leave race' })
    const roomId = created.room?.id ?? ''
    expect(roomId).not.toBe('')
    const count = 20
    for (let index = 0; index < count; index += 1) {
      const joined = await harness.rooms.join(roomId, { sessionId: `s-${String(index)}`, label: `m${String(index)}` })
      expect(joined.ok).toBe(true)
    }
    expect((await harness.rooms.get(roomId))?.members).toHaveLength(count)

    const leaves = await Promise.all(
      Array.from({ length: count }, (_, index) => harness.rooms.leave(roomId, `s-${String(index)}`)),
    )
    expect(leaves.every(leave => leave.ok)).toBe(true)
    expect((await harness.rooms.get(roomId))?.members).toHaveLength(0)
  })
})
