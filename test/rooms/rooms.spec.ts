/**
 * Rooms module: wiring, the six tools, membership, status mapping and the
 * restart-safe sequence counter. Store-backed on purpose — the behaviour under
 * test (seq monotonicity, quarantine-free reads, the consumed ledger) is the
 * on-disk one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply as applyRooms, TOOLS as ROOM_TOOLS } from '../../src/host/modules/rooms/index.ts'
import { registerRoomContext } from '../../src/host/modules/rooms/context.ts'
import { apply as applySessions } from '../../src/host/modules/sessions/index.ts'
import { neutralize } from '../../src/lib/sanitize.ts'
import { callTool, makeFakeAgent, makeHarness } from './helpers.ts'
import type { FakeAgent, Harness } from './helpers.ts'

let harness: Harness
let author: FakeAgent
let peer: FakeAgent

beforeEach(async () => {
  author = makeFakeAgent('sess-author', { status: 'idle', model: 'glm-4', cwd: '/work/project' })
  peer = makeFakeAgent('sess-peer', { status: 'idle', model: 'glm-4', cwd: '/work/project' })
  harness = await makeHarness({ agents: [author, peer] })
  applyRooms(harness.deps)
  applySessions(harness.deps)
})

afterEach(async () => {
  await harness.dispose()
})

async function createRoom(title = 'launch room'): Promise<string> {
  const result = await callTool(harness.fake.tools.get('cortex_room_create'), { title }, author)
  expect(result.status).toBe('created')
  return String(result.roomId)
}

describe('module wiring (round-12 contract)', () => {
  it('mounts beside the status module with no tool or context collision', async () => {
    const local = await makeHarness({ agents: [author] })
    try {
      const status = await import('../../src/host/modules/status/index.ts')
      status.apply(local.deps)
      applyRooms(local.deps)
      applySessions(local.deps)
      // Nine tools, no duplicate name (the host registry would have thrown).
      expect(local.fake.registeredNames).toHaveLength(10)
      expect(new Set(local.fake.registeredNames).size).toBe(10)
      expect(local.fake.registeredNames).toContain('cortex_status')
      expect(local.fake.registeredNames.filter(name => name.startsWith('cortex_room_'))).toHaveLength(7)
      expect(local.fake.registeredNames.filter(name => name.startsWith('cortex_session_'))).toHaveLength(2)
      expect(local.fake.contexts.map(entry => entry.name)).toEqual(['cortex:rooms'])
      // P4: nothing in the wiring produced a warning.
      expect(local.fake.warnings).toEqual([])
    } finally {
      await local.dispose()
    }
  })

  it('registers the room tools and the cortex:rooms context once', () => {
    expect(harness.fake.registeredNames.filter(name => name.startsWith('cortex_room_'))).toEqual([...ROOM_TOOLS])
    expect(harness.fake.contexts.map(entry => entry.name)).toEqual(['cortex:rooms'])
    expect(harness.fake.contexts[0]?.order).toBe(42)
    expect(harness.fake.serviceNames).toContain('systemPrompt')
  })

  it('a duplicate context registration is reported, never thrown (P4)', () => {
    const again = registerRoomContext(harness.rooms, { get: name => harness.deps.ctx.get(name), effect: run => harness.deps.ctx.effect(run) })
    expect(again.ok).toBe(false)
    expect(again.message).toContain('already registered')
    expect(harness.fake.contexts).toHaveLength(1)
  })

  it('every tool description and param string is brace-free (host #53 / G14)', () => {
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
      : Array.isArray(value) ? value.flatMap(strings)
        : value !== null && typeof value === 'object' ? Object.values(value as Record<string, unknown>).flatMap(strings) : []
    for (const definition of harness.fake.tools.values()) {
      for (const text of strings(definition.parameters).concat([definition.description])) {
        expect(text.includes('{{') || text.includes('}}')).toBe(false)
      }
    }
  })

  it('no systemPrompt service: rooms still wire and say so', async () => {
    const local = await makeHarness({ agents: [author], noSystemPrompt: true })
    try {
      applyRooms(local.deps)
      expect(local.fake.tools.has('cortex_room_read')).toBe(true)
      expect(local.fake.warnings.join(' ')).toContain('no systemPrompt service')
    } finally {
      await local.dispose()
    }
  })
})

describe('cortex_room_create / list / join', () => {
  it('creates a room on disk and joins the calling session', async () => {
    const roomId = await createRoom()
    const doc = JSON.parse(await readFile(join(harness.root, 'rooms', roomId, 'room.json'), 'utf8')) as { title: string; members: unknown[]; id: string }
    expect(doc.id).toBe(roomId)
    expect(doc.title).toBe('launch room')
    expect(doc.members).toHaveLength(1)
    const room = await harness.rooms.get(roomId)
    expect(room?.members[0]?.sessionId).toBe('sess-author')
    expect(room?.members[0]?.label).toBe('session sess-author')
    // The inbox staging dir exists, so a caller can actually drop a file.
    const note = await readFile(join(harness.root, 'rooms', roomId, 'inbox', 'README.txt'), 'utf8')
    expect(note).toContain('state root')
  })

  it('lists rooms with live member states and a title-safe line', async () => {
    const roomId = await createRoom('alpha')
    const listed = await callTool(harness.fake.tools.get('cortex_room_list'), {}, author)
    expect(listed.count).toBe(1)
    expect(listed.rooms[0].id).toBe(roomId)
    expect(String(listed.message)).toContain('session sess-author=idle')
  })

  it('an empty store lists nothing and stays useful', async () => {
    const listed = await callTool(harness.fake.tools.get('cortex_room_list'), {}, author)
    expect(listed.count).toBe(0)
    expect(String(listed.message)).toContain('cortex_room_create')
  })

  it('joins the caller by default and another session only when it is live', async () => {
    const roomId = await createRoom()
    const outsider = makeFakeAgent('sess-outsider', { status: 'running' })
    harness.fake.agents.set(outsider.id, outsider)
    const joined = await callTool(harness.fake.tools.get('cortex_room_join'), { roomId, label: 'outsider', sessionId: 'sess-outsider' }, author)
    expect(joined.status).toBe('joined')
    const room = await harness.rooms.get(roomId)
    expect(room?.members.map(member => member.label)).toEqual(['session sess-author', 'outsider'])
    expect(room?.members[1]?.state).toBe('running')
  })

  it('refuses to enroll a session the host does not report as live', async () => {
    const roomId = await createRoom()
    const result = await callTool(harness.fake.tools.get('cortex_room_join'), { roomId, sessionId: 'sess-ghost' }, author)
    expect(result.status).toBe('refused')
    expect(String(result.message)).toContain('not live')
  })

  it('posting stamps the author row so lastSeen means something', async () => {
    const roomId = await createRoom()
    expect((await harness.rooms.get(roomId))?.members[0]?.lastActivityAt).toBeUndefined()
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'spoke' }, author)
    const member = (await harness.rooms.get(roomId))?.members[0]
    expect(typeof member?.lastActivityAt).toBe('string')
    expect(String(member?.lastActivityAt)).toMatch(/^2\d{3}-/)
  })

  it('leave removes exactly one member row', async () => {
    const roomId = await createRoom()
    const gone = await harness.rooms.leave(roomId, 'sess-author')
    expect(gone.ok).toBe(true)
    const room = await harness.rooms.get(roomId)
    expect(room?.members).toHaveLength(0)
    expect((await harness.rooms.leave(roomId, 'sess-author')).ok).toBe(false)
  })
})

describe('cortex_room_post / read', () => {
  it('posts with a monotonic seq, then reads it back oldest-first', async () => {
    const roomId = await createRoom()
    const first = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'one' }, author)
    const second = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'two' }, author)
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    const read = await callTool(harness.fake.tools.get('cortex_room_read'), { roomId }, author)
    expect(read.count).toBe(2)
    expect(String(read.text)).toContain('#1')
    expect(String(read.text)).toContain('two')
    const skipped = await callTool(harness.fake.tools.get('cortex_room_read'), { roomId, sinceSeq: 1 }, author)
    expect(skipped.messages.map((row: { seq: number }) => row.seq)).toEqual([2])
  })

  it('the author is never mailed their own message', async () => {
    const roomId = await createRoom()
    await harness.rooms.join(roomId, { label: 'peer', sessionId: 'sess-peer' })
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'hello room' }, author)
    expect(posted.counts.self).toBe(1)
    // The live idle peer was woken, so nothing is queued for it either.
    expect(posted.counts.wake + posted.counts.nextStep).toBe(1)
    expect(peer.received).toHaveLength(1)
    expect(harness.rooms.renderFor('sess-author')).toBe('')
    expect(harness.rooms.renderFor('sess-peer')).toBe('')
  })

  it('notify=false stores without reaching anyone', async () => {
    const roomId = await createRoom()
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'quiet note', notify: false }, author)
    expect(posted.status).toBe('posted')
    expect(posted.counts).toBeNull()
    expect(peer.received).toHaveLength(0)
    const room = await harness.rooms.get(roomId)
    expect(room?.lastSeq).toBe(1)
  })

  it('a session that never joined cannot put words in the room', async () => {
    const roomId = await createRoom()
    const stranger = makeFakeAgent('sess-stranger', { status: 'idle' })
    harness.fake.agents.set(stranger.id, stranger)
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'from outside' }, stranger)
    expect(posted.status).toBe('refused')
    expect(String(posted.message)).toContain('not a member')
    expect(String(posted.message)).toContain('cortex_room_join')
    const transcript = await harness.rooms.read(roomId)
    expect(transcript.messages).toHaveLength(0)
  })

  it('unknown rooms and empty bodies are refused as sentences', async () => {
    const missing = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId: 'nope', text: 'x' }, author)
    expect(missing.status).toBe('refused')
    expect(String(missing.message)).toContain('no such room')
    const roomId = await createRoom()
    const empty = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: '   ' }, author)
    expect(empty.status).toBe('refused')
  })

  it('seq keeps counting up across a restart (new store, same root)', async () => {
    const roomId = await createRoom()
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'before' }, author)
    // New store instance over the same root, i.e. what a host restart sees.
    harness.restart()
    const after = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'after' }, author)
    expect(after.seq).toBe(2)
    const room = await harness.rooms.get(roomId)
    expect(room?.lastSeq).toBe(2)
  })

  it('recovers the counter above the message files when seq.txt is lost', async () => {
    const roomId = await createRoom()
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'one' }, author)
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'two' }, author)
    const seqFile = join(harness.root, 'rooms', roomId, 'seq.txt')
    expect(await readFile(seqFile, 'utf8')).toContain('2')
    const { rm } = await import('node:fs/promises')
    await rm(seqFile, { force: true })
    harness.restart()
    const next = await harness.rooms.post({ roomId, text: 'three', fromSessionId: 'sess-author' })
    expect(next.ok).toBe(true)
    expect(next.seq).toBe(3)
  })
})

describe('cortex_room_status (live state join)', () => {
  it('maps running / idle / gone and reports unread counts', async () => {
    const roomId = await createRoom()
    const runner = makeFakeAgent('sess-runner', { status: 'running' })
    harness.fake.agents.set(runner.id, runner)
    await callTool(harness.fake.tools.get('cortex_room_join'), { roomId, label: 'runner', sessionId: 'sess-runner' }, author)
    // And a member the host no longer reports: 'gone', not 'unknown'.
    await harness.rooms.join(roomId, { label: 'vanished', sessionId: 'sess-vanished' })
    const status = await callTool(harness.fake.tools.get('cortex_room_status'), { roomId }, author)
    expect(status.status).toBe('ok')
    const byId = Object.fromEntries((status.members as Array<{ sessionId: string; state: string }>).map(row => [row.sessionId, row.state]))
    expect(byId['sess-author']).toBe('idle')
    expect(byId['sess-runner']).toBe('running')
    expect(byId['sess-vanished']).toBe('gone')
    expect(status.counts).toMatchObject({ idle: 1, running: 1, gone: 1 })
    expect(status.lastSeq).toBe(0)
  })

  it('a host whose roots() throws degrades to gone, not a crash', async () => {
    const local = await makeHarness({ agents: [author], rootsThrows: true })
    try {
      applyRooms(local.deps)
      const roomId = await callTool(local.fake.tools.get('cortex_room_create'), { title: 'x' }, author)
      expect(roomId.status).toBe('created')
      await local.rooms.join(roomId.roomId, { label: 'vanished', sessionId: 'sess-vanished' })
      const status = await callTool(local.fake.tools.get('cortex_room_status'), { roomId: roomId.roomId }, author)
      const byId = Object.fromEntries((status.members as Array<{ sessionId: string; state: string }>).map(row => [row.sessionId, row.state]))
      // get() still answers, so a live member is idle; a member the host does
      // not know is 'gone'; and the roots() failure is only a warning.
      expect(byId['sess-author']).toBe('idle')
      expect(byId['sess-vanished']).toBe('gone')
      expect((await local.rooms.list()).length).toBe(1)
      expect(local.fake.warnings.join(' ')).toContain('agents.roots() failed')
    } finally {
      await local.dispose()
    }
  })
})

describe('rooms.enabled kill-switch (P3)', () => {
  it('disables posting and the injected block, and says why', async () => {
    const roomId = await createRoom()
    harness.setConfig({ rooms: { enabled: false } })
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'after disable' }, author)
    expect(posted.status).toBe('refused')
    expect(String(posted.message)).toContain('rooms.enabled')
    expect(harness.rooms.renderFor('sess-peer')).toBe('')
    // Reading stays available: turning the feature off must not hide data.
    const read = await callTool(harness.fake.tools.get('cortex_room_read'), { roomId }, author)
    expect(read.count).toBe(0)
  })
})

describe('rpc endpoint maps', () => {
  it('rooms.list / rooms.status / rooms.read answer through the same service', async () => {
    const { readEndpoints } = await import('../../src/host/modules/rooms/rpc.ts')
    const roomId = await createRoom('rpc room')
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'via rpc' }, author)
    const listed = await readEndpoints['rooms.list']?.({})
    expect(listed?.ok).toBe(true)
    const rooms = (listed?.ok ? (listed.value as { rooms: Array<{ id: string; members: Array<{ status: string }> }> }) : undefined)?.rooms
    expect(rooms?.[0]?.members[0]?.status).toBe('idle')
    const status = await readEndpoints['rooms.status']?.({ roomId })
    expect(status?.ok).toBe(true)
    const read = await readEndpoints['rooms.read']?.({ roomId })
    expect(read?.ok).toBe(true)
    const missing = await readEndpoints['rooms.read']?.({ roomId: 'not-a-room' })
    expect(missing?.ok).toBe(false)
  })

  it('write endpoints need their fields and never throw at the transport', async () => {
    const { writeEndpoints } = await import('../../src/host/modules/rooms/rpc.ts')
    const nope = await writeEndpoints['rooms.post']?.({ text: 'no room' })
    expect(nope?.ok).toBe(false)
    const created = await writeEndpoints['rooms.create']?.({ title: 'from ui', sessionId: 'ui-session' })
    expect(created?.ok).toBe(true)
    const roomId = String((created?.ok ? (created.value as { room: { id: string } }).room.id : ''))
    const posted = await writeEndpoints['rooms.post']?.({ roomId, text: 'hello from the panel', sessionId: 'ui-session' })
    expect(posted?.ok).toBe(true)
    const transcript = await harness.rooms.read(roomId)
    expect(transcript.messages[0]?.fromLabel).toBe('session ui-session')
    expect(transcript.messages[0]?.fromSessionId).toBe('ui-session')
    const left = await writeEndpoints['rooms.leave']?.({ roomId, sessionId: 'ui-session' })
    expect(left?.ok).toBe(true)
  })

  it('rooms.delete deletes nothing on the first call and everything on the second', async () => {
    const { writeEndpoints } = await import('../../src/host/modules/rooms/rpc.ts')
    const roomId = await createRoom('doomed room')
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'will be lost' }, author)

    // Arm: no confirm, so the host resolves the room, names what is inside it and
    // issues a token. The room must still be there afterwards.
    const armed = await writeEndpoints['rooms.delete']?.({ roomId })
    expect(armed?.ok).toBe(true)
    const armValue = armed?.ok ? (armed.value as { deleted?: boolean; token?: string; message?: string }) : {}
    expect(armValue.deleted).not.toBe(true)
    expect(typeof armValue.token).toBe('string')
    expect(String(armValue.token).length).toBeGreaterThan(0)
    // The host's own summary is the warning the panel shows before Confirm.
    expect(String(armValue.message)).toContain('not reversible')
    expect(await harness.rooms.get(roomId)).toBeDefined()

    // No token at all: refused, and still nothing destroyed.
    const blind = await writeEndpoints['rooms.delete']?.({ roomId, confirm: '' })
    expect(blind?.ok).toBe(false)
    expect(await harness.rooms.get(roomId)).toBeDefined()

    // The real token: this is the only call that deletes.
    const done = await writeEndpoints['rooms.delete']?.({ roomId, confirm: armValue.token })
    expect(done?.ok).toBe(true)
    expect((done?.ok ? (done.value as { deleted?: boolean }).deleted : false)).toBe(true)
    expect(await harness.rooms.get(roomId)).toBeUndefined()

    // The token is single-use: replaying it is refused, and the room is already gone.
    const replay = await writeEndpoints['rooms.delete']?.({ roomId, confirm: armValue.token })
    expect(replay?.ok).toBe(false)
  })

  it('a token issued for one room cannot delete another', async () => {
    const { writeEndpoints } = await import('../../src/host/modules/rooms/rpc.ts')
    const first = await createRoom('first')
    const second = await createRoom('second')
    const armed = await writeEndpoints['rooms.delete']?.({ roomId: first })
    const token = armed?.ok ? (armed.value as { token?: string }).token : undefined
    expect(typeof token).toBe('string')

    // Presenting room A's token against room B deletes nothing.
    const wrong = await writeEndpoints['rooms.delete']?.({ roomId: second, confirm: token })
    expect(wrong?.ok).toBe(false)
    expect(await harness.rooms.get(second)).toBeDefined()

    // And A itself is still there until its own token is presented.
    expect(await harness.rooms.get(first)).toBeDefined()
  })

  it('rooms.delete needs a roomId and refuses cleanly for an unknown one', async () => {
    const { writeEndpoints } = await import('../../src/host/modules/rooms/rpc.ts')
    const blank = await writeEndpoints['rooms.delete']?.({})
    expect(blank?.ok).toBe(false)
    const unknown = await writeEndpoints['rooms.delete']?.({ roomId: 'not-a-room' })
    expect(unknown?.ok).toBe(false)
  })

  it('an unbound endpoint answers "not wired" instead of throwing (P4)', async () => {
    // Fresh module graph = the maps before any apply() bound them.
    vi.resetModules()
    const fresh = await import('../../src/host/modules/rooms/rpc.ts')
    const answer = await fresh.readEndpoints['rooms.list']?.({})
    expect(answer?.ok).toBe(false)
    // `not-wired` is OUR code; the host carries `internal` and ours rides in the
    // message (src/host/rpc-error.ts).
    expect(answer && !answer.ok ? answer.error.code : '').toBe('internal')
    expect(answer && !answer.ok ? answer.error.message : '').toContain('[not-wired]')
  })

  it('only the endpoint names the contract freezes are exported', async () => {
    const { readEndpoints, writeEndpoints } = await import('../../src/host/modules/rooms/rpc.ts')
    expect(Object.keys(readEndpoints).sort()).toEqual(['rooms.list', 'rooms.read', 'rooms.status'])
    expect(Object.keys(writeEndpoints).sort()).toEqual(['rooms.create', 'rooms.delete', 'rooms.join', 'rooms.leave', 'rooms.post'])
  })
})

describe('state-root discipline (P5)', () => {
  it('a message lands exactly where DESIGN §2 says, inside the root', async () => {
    const roomId = await createRoom()
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'check the tree' }, author)
    const doc = JSON.parse(await readFile(join(harness.root, 'rooms', roomId, 'messages', '000001.json'), 'utf8')) as { seq: number; text: string; roomId: string }
    expect(doc).toMatchObject({ seq: 1, roomId, text: 'check the tree' })
    expect(neutralize(doc.text)).toBe(doc.text)
  })
})

describe('cortex_room_delete', () => {
  /** First call: issues the token and must delete nothing. */
  async function arm(roomId: string): Promise<Record<string, unknown>> {
    const armed = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId }, author)
    expect(armed.status).toBe('ok')
    expect(armed.deleted).toBe(false)
    expect(typeof armed.token).toBe('string')
    // Arming is not deleting: this is the whole point of the two steps.
    expect(await harness.rooms.get(roomId)).toBeDefined()
    return armed
  }

  it('the first call reports the room and deletes nothing', async () => {
    const roomId = await createRoom()
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'keep this until deleted' }, author)
    const armed = await arm(roomId)
    expect(String(armed.message)).toContain('1 message(s)')
    expect(String(armed.message)).toContain('not reversible')
  })

  it('the second call deletes the room, its messages and its boards', async () => {
    const roomId = await createRoom()
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'doomed' }, author)
    const armed = await arm(roomId)
    const done = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId, confirm: String(armed.token) }, author)
    expect(done.status).toBe('ok')
    expect(done.deleted).toBe(true)
    expect(await harness.rooms.get(roomId)).toBeUndefined()
    // The whole subtree went, not just room.json: a room that reads back as
    // "no such room" but still has boards on disk is the bug this asserts.
    expect(await harness.store.listBoards(roomId)).toMatchObject({ ok: true, data: [] })
  })

  it('a guessed or literal confirm deletes nothing', async () => {
    const roomId = await createRoom()
    for (const confirm of ['DELETE', 'confirm', '', '   ']) {
      const refused = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId, confirm }, author)
      expect(refused.status).toBe('refused')
      expect(await harness.rooms.get(roomId)).toBeDefined()
    }
  })

  it('a token cannot be replayed, and does not open another room', async () => {
    const first = await createRoom('first')
    const second = await createRoom('second')
    const armed = await arm(first)
    const token = String(armed.token)

    // Issued for `first`, presented against `second`: refused, and `second`
    // survives. `ConfirmTokens.consume` deletes the row BEFORE comparing keys,
    // so this burns the token rather than leaving it usable — fail-closed, and
    // the same shape as the memory delete. That is why the next call needs a
    // fresh token and why `first` is still here.
    const crossed = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId: second, confirm: token }, author)
    expect(crossed.status).toBe('refused')
    expect(await harness.rooms.get(second)).toBeDefined()

    const burned = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId: first, confirm: token }, author)
    expect(burned.status).toBe('refused')
    expect(await harness.rooms.get(first)).toBeDefined()

    // A freshly armed token works once and only once.
    const rearmed = await arm(first)
    const once = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId: first, confirm: String(rearmed.token) }, author)
    expect(once.deleted).toBe(true)
    const twice = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId: first, confirm: String(rearmed.token) }, author)
    expect(twice.status).toBe('refused')
  })

  it('an unknown room is refused without a token', async () => {
    const refused = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId: 'no-such-room' }, author)
    expect(refused.status).toBe('refused')
    expect(String(refused.message)).toContain('no such room')
    expect(refused.token).toBeNull()
  })

  it('a running member is named in the warning, and the delete still works', async () => {
    // Refusing here would be unrecoverable: `leave` is reachable only from the
    // panel's RPC endpoint, so an agent could never clear the block. The member
    // is named so the cost is visible, and the delete proceeds.
    const roomId = await createRoom()
    const armed = await arm(roomId)
    expect(String(armed.message)).toMatch(/no member is running|WARNING/)
    const done = await callTool(harness.fake.tools.get('cortex_room_delete'), { roomId, confirm: String(armed.token) }, author)
    expect(done.deleted).toBe(true)
  })

  it('rooms.enabled = false refuses and changes nothing', async () => {
    const off = await makeHarness({ agents: [author] })
    try {
      const baseCfg = off.deps.cfg
      off.deps.cfg = () => ({ ...baseCfg(), rooms: { enabled: false } })
      applyRooms(off.deps)
      const refused = await callTool(off.fake.tools.get('cortex_room_delete'), { roomId: 'anything' }, author)
      expect(refused.status).toBe('refused')
      expect(String(refused.message)).toContain('rooms.enabled = false')
    } finally {
      await off.dispose()
    }
  })
})
