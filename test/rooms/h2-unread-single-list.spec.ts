import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply as applyRooms } from '../../src/host/modules/rooms/index.ts'
import { callTool, makeFakeAgent, makeHarness } from './helpers.ts'
import type { FakeAgent, Harness } from './helpers.ts'

/**
 * H2: `cortex_room_status` counts unread mail per member. The old shape asked
 * the STORE for a message page once PER MEMBER — N members, N directory
 * listings, N sets of file reads — even though every member reads the same
 * room. One listing answers for all of them: read the newest page after the
 * LOWEST watermark and filter it per member.
 *
 * The per-member cap (QUEUE_MAX * 2) is part of the contract, so the case
 * below pins a member who has consumed almost everything (expect 5) next to
 * members at the cap (expect 50). An implementation that read one page and
 * counted it without honouring each member's watermark would answer 50 for
 * everyone, and this test would catch it.
 */

const SESSIONS = ['sess-a', 'sess-b', 'sess-c', 'sess-d'] as const
const PAGE = 50 // QUEUE_MAX * 2

let harness: Harness
let author: FakeAgent

beforeEach(async () => {
  author = makeFakeAgent(SESSIONS[0], { status: 'idle', model: 'glm-4', cwd: '/work/project' })
  harness = await makeHarness({ agents: [author] })
  applyRooms(harness.deps)
})

afterEach(async () => {
  await harness.dispose()
})

describe('H2: unread counts come from ONE room listing', () => {
  it('reads the room once for four members and keeps every per-member count exact', async () => {
    const created = await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'h2 room' }, author)
    expect(created.status).toBe('created')
    const roomId = String(created.roomId)
    for (const sessionId of SESSIONS) {
      const joined = await harness.rooms.join(roomId, { label: sessionId, sessionId })
      expect(joined.ok).toBe(true)
    }

    // 30 messages from sess-a: the author moves past its own words each time.
    for (let i = 0; i < 30; i += 1) {
      const posted = await harness.rooms.post({ roomId, text: `a says ${i}`, fromSessionId: SESSIONS[0], notify: false })
      expect(posted.ok).toBe(true)
    }
    // 80 system messages (no author session): nobody's watermark moves.
    for (let i = 0; i < 80; i += 1) {
      const posted = await harness.rooms.post({ roomId, text: `system says ${i}`, fromKind: 'system', notify: false })
      expect(posted.ok).toBe(true)
    }
    // sess-c has read all but the last five.
    harness.rooms.consume(SESSIONS[2], roomId, 105)

    // Count the store calls made by unreadCounts itself, nothing else.
    const store = harness.store
    const original = store.readMessages.bind(store)
    let calls = 0
    let lastOptions: { sinceSeq?: number; limit?: number } | undefined
    ;(store as unknown as { readMessages: typeof store.readMessages }).readMessages = (room, options = {}) => {
      calls += 1
      lastOptions = options
      return original(room, options)
    }

    const room = await harness.rooms.get(roomId)
    expect(room).toBeDefined()
    if (room === undefined) return
    const counts = await harness.rooms.unreadCounts(room)

    expect(calls, 'one listing must answer for every member').toBe(1)
    expect(counts).toEqual({ 'sess-a': PAGE, 'sess-b': PAGE, 'sess-c': 5, 'sess-d': PAGE })
    // The single listing starts at the LOWEST watermark, or a member that read
    // nothing would be counted from the oldest message on disk.
    expect(lastOptions?.sinceSeq).toBe(0)
    expect(lastOptions?.limit).toBe(PAGE)
  })

  it('reports zero unread for a member that consumed everything, one listing', async () => {
    const created = await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'h2 quiet' }, author)
    const roomId = String(created.roomId)
    for (const sessionId of SESSIONS) await harness.rooms.join(roomId, { label: sessionId, sessionId })
    for (let i = 0; i < 5; i += 1) {
      await harness.rooms.post({ roomId, text: `system says ${i}`, fromKind: 'system', notify: false })
    }
    const last = await harness.store.readMessages(roomId, { limit: 1 })
    const lastSeq = last.ok && last.data.length > 0 ? (last.data[last.data.length - 1]?.seq ?? 0) : 0
    for (const sessionId of SESSIONS) harness.rooms.consume(sessionId, roomId, lastSeq)

    const store = harness.store
    const original = store.readMessages.bind(store)
    let calls = 0
    ;(store as unknown as { readMessages: typeof store.readMessages }).readMessages = (room, options = {}) => {
      calls += 1
      return original(room, options)
    }
    const room = await harness.rooms.get(roomId)
    expect(room).toBeDefined()
    if (room === undefined) return
    const counts = await harness.rooms.unreadCounts(room)
    expect(calls).toBe(1)
    expect(counts).toEqual({ 'sess-a': 0, 'sess-b': 0, 'sess-c': 0, 'sess-d': 0 })
  })

  it('answers zero for every member when the room read fails, and still reads once', async () => {
    const created = await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'h2 broken' }, author)
    const roomId = String(created.roomId)
    await harness.rooms.join(roomId, { label: SESSIONS[0], sessionId: SESSIONS[0] })
    const store = harness.store
    let calls = 0
    ;(store as unknown as { readMessages: typeof store.readMessages }).readMessages = () => {
      calls += 1
      return Promise.resolve({ ok: false, error: 'EIO' } as never)
    }
    const room = await harness.rooms.get(roomId)
    expect(room).toBeDefined()
    if (room === undefined) return
    const counts = await harness.rooms.unreadCounts(room)
    expect(calls).toBe(1)
    expect(counts).toEqual({ [SESSIONS[0]]: 0 })
  })
})
