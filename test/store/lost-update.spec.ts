/**
 * Lost update on the store's read-modify-write paths.
 *
 * Several `write()` methods do read -> mutate -> `writeJsonAtomic` on a SHARED
 * file (one `todos/<track>.json` per track, one `rooms/<id>/room.json` per
 * room). The atomic rename guarantees the file is never torn, but it does not
 * isolate the read from another writer's rename: two writers that overlap in
 * time both read the same snapshot and the later rename discards the earlier
 * writer's change. `serializePerRoom` covers `postMessage` and `touchMember`
 * only.
 *
 * The overlap here is not exotic: a host may batch several tool calls of one
 * turn, and two sessions acting on the same room at the same time is the whole
 * point of rooms. Both cases below are ordinary usage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore } from '../../src/host/store.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'

let root = ''

beforeEach(async () => { root = await makeTempRoot('dsh-cortex-lost-update-') })
afterEach(async () => { await removeTempRoot(root) })

function makeStore(): CortexStore {
  return new CortexStore({ root, warn: () => {} })
}

describe('store read-modify-write keeps every concurrent change', () => {
  it('keeps every todo when 20 adds overlap', async () => {
    const store = makeStore()
    await store.init()
    const count = 20
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) => store.addTodo({ track: 'work', text: `todo ${String(index)}` })),
    )
    expect(results.every(result => result.ok)).toBe(true)
    const listed = await store.listTodos({ tracks: ['work'] })
    expect(listed.ok).toBe(true)
    expect(listed.data).toHaveLength(count)
  })

  it('keeps every member when 20 room joins overlap', async () => {
    const store = makeStore()
    await store.init()
    const created = await store.createRoom({ title: 'race' })
    if (!created.ok) throw new Error(created.error)
    const roomId = created.data.id
    const count = 20
    const joins = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.joinRoom(roomId, { sessionId: `session-${String(index)}`, label: `m${String(index)}` })),
    )
    expect(joins.every(join => join.ok)).toBe(true)
    const fresh = await store.getRoom(roomId)
    expect(fresh.data?.members).toHaveLength(count)
  })
})
