/**
 * `cortex_session_spawn` / `cortex_session_send` (BRIEFS §M5: spawn is
 * feature-detected, the refusal is honest, and rooms keep working without it).
 *
 * The create-options the module sends are asserted field by field, because the
 * host shape (`CreateAgentOptions`, packages/core/agent/src/index.ts:80) accepts
 * more than this module uses — the test IS the statement of what we send.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply as applyRooms } from '../../src/host/modules/rooms/index.ts'
import { apply as applySessions } from '../../src/host/modules/sessions/index.ts'
import { checkSpawnCwd, liveSpawnedCount, newSessionId, recallSpawnedSession, spawnFactory, spawnedSessionIds } from '../../src/host/modules/sessions/spawn.ts'
import { callTool, makeFakeAgent, makeHarness } from './helpers.ts'
import type { FakeAgent, Harness } from './helpers.ts'

let harness: Harness
let author: FakeAgent

beforeEach(async () => {
  author = makeFakeAgent('sess-author', { status: 'idle', provider: 'deepseek', model: 'dsh-chat', cwd: '/work/project' })
  harness = await makeHarness({ agents: [author], withCreate: true })
  applyRooms(harness.deps)
  applySessions(harness.deps)
})

afterEach(async () => {
  await harness.dispose()
})

async function roomId(): Promise<string> {
  return String((await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'spawn lab' }, author)).roomId)
}

describe('feature detection', () => {
  it('agents.create is detected only when it is a function', () => {
    expect(spawnFactory(harness.deps.ctx.agents)).toBeTypeOf('function')
    expect(spawnFactory({ get: () => undefined, roots: () => [] })).toBeUndefined()
    expect(spawnFactory(undefined)).toBeUndefined()
    expect(spawnFactory({ get: () => undefined, roots: () => [], create: 'not-a-function' } as never)).toBeUndefined()
  })

  it('the room status tool reports whether this host can spawn at all', async () => {
    const room = await roomId()
    const status = await callTool(harness.fake.tools.get('cortex_room_status'), { roomId: room }, author)
    expect(status.hostCanSpawn).toBe(true)
  })

  it('a host with no factory refuses and points at joining existing sessions', async () => {
    const local = await makeHarness({ agents: [author], withCreate: false })
    try {
      applyRooms(local.deps)
      applySessions(local.deps)
      const created = String((await callTool(local.fake.tools.get('cortex_room_create'), { title: 'still works' }, author)).roomId)
      const room = created
      expect((await callTool(local.fake.tools.get('cortex_room_status'), { roomId: room }, author)).hostCanSpawn).toBe(false)
      const result = await callTool(local.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'worker', prompt: 'do the thing' }, author)
      expect(result.status).toBe('refused')
      expect(result.hostCanSpawn).toBe(false)
      expect(String(result.message)).toContain('no session was created')
      expect(String(result.hint)).toContain('cortex_room_join')
      expect(local.fake.createCalls).toHaveLength(0)
      // ...and the room itself still functions: the author can post and read.
      const posted = await callTool(local.fake.tools.get('cortex_room_post'), { roomId: room, text: 'hello anyway' }, author)
      expect(posted.status).toBe('posted')
    } finally {
      await local.dispose()
    }
  })

  it('a host that rejects create reports the host message verbatim-safe', async () => {
    const local = await makeHarness({ agents: [author], withCreate: true, createThrows: 'no agent factory registered' })
    try {
      applyRooms(local.deps)
      applySessions(local.deps)
      const room = String((await callTool(local.fake.tools.get('cortex_room_create'), { title: 'x' }, author)).roomId)
      const result = await callTool(local.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'w', prompt: 'p' }, author)
      expect(result.status).toBe('refused')
      expect(String(result.message)).toContain('no agent factory registered')
      expect(String(result.message)).toContain('cortex_room_join')
    } finally {
      await local.dispose()
    }
  })
})

describe('cortex_session_spawn (with a factory)', () => {
  it('sends exactly the create options this module owns', async () => {
    const room = await roomId()
    const result = await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'worker', prompt: 'triage the failures' }, author)
    expect(result.status).toBe('spawned')
    expect(harness.fake.createCalls).toHaveLength(1)
    const options = harness.fake.createCalls[0]?.options as Record<string, Record<string, string>> & { sessionId: string }
    expect(Object.keys(options).sort()).toEqual(['agentOptions', 'meta', 'sessionId'])
    expect(options.sessionId).toMatch(/^cortex-[0-9a-f]{12}$/)
    expect(options.meta).toEqual({ cwd: '/work/project', parentSession: 'sess-author' })
    // Inherited from the caller unless given (BRIEFS M5).
    expect(options.agentOptions).toEqual({ provider: 'deepseek', model: 'dsh-chat' })
    expect(result.sessionId).toBe(options.sessionId)
    expect(spawnedSessionIds()).toContain(options.sessionId)
  })

  it('an explicit model/provider overrides the inherited one', async () => {
    const room = await roomId()
    await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'w', prompt: 'p', model: 'other-model', provider: 'other' }, author)
    const options = harness.fake.createCalls[0]?.options as { agentOptions: Record<string, string> }
    expect(options.agentOptions).toEqual({ provider: 'other', model: 'other-model' })
  })

  it('enrolls the new session, announces it, and hands the task to it alone', async () => {
    const room = await roomId()
    const bystander = makeFakeAgent('sess-bystander', { status: 'idle' })
    harness.fake.agents.set(bystander.id, bystander)
    await harness.rooms.join(room, { label: 'bystander', sessionId: bystander.id })
    const result = await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'worker', prompt: 'run the migration' }, author)
    expect(result.status).toBe('spawned')
    const enrolled = await harness.rooms.get(room)
    expect(enrolled?.members.map(member => member.label)).toContain('worker')
    expect(enrolled?.members.find(member => member.label === 'worker')?.sessionId).toBe(result.sessionId)
    const created = harness.fake.agents.get(String(result.sessionId)) as FakeAgent
    expect(created.textOf()).toContain('run the migration')
    expect(created.received.map(entry => entry.method)).toEqual(['followup'])
    expect(bystander.received).toHaveLength(0)
    // The task IS stored in the room (auditable, replayable) but only the new
    // member was reached; the join line is a separate system message.
    const transcript = await harness.rooms.read(room)
    expect(transcript.messages.some(message => message.text.includes('run the migration'))).toBe(true)
    expect(transcript.messages.some(message => message.fromKind === 'system')).toBe(true)
    expect(bystander.received).toHaveLength(0)
  })

  it('the new member is a real recipient afterwards', async () => {
    const room = await roomId()
    const result = await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'worker', prompt: 'p' }, author)
    const again = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId: room, text: 'follow-up for the room' }, author)
    expect(again.counts.wake).toBeGreaterThanOrEqual(1)
    const created = harness.fake.agents.get(String(result.sessionId)) as FakeAgent
    expect(created.received.length).toBe(2)
    expect(created.textOf(1)).toContain('follow-up for the room')
  })

  it('a non-member cannot populate a room it never joined', async () => {
    const room = await roomId()
    const outsider = makeFakeAgent('sess-outsider', { status: 'idle', cwd: '/work/project' })
    harness.fake.agents.set(outsider.id, outsider)
    const result = await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'w', prompt: 'p' }, outsider)
    expect(result.status).toBe('refused')
    expect(String(result.message)).toContain('not a member')
    expect(harness.fake.createCalls).toHaveLength(0)
  })

  it('a missing label/prompt/room is refused before anything is created', async () => {
    const room = await roomId()
    expect((await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: '', prompt: 'p' }, author)).status).toBe('refused')
    expect((await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'w', prompt: '  ' }, author)).status).toBe('refused')
    expect((await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: 'nope', label: 'w', prompt: 'p' }, author)).status).toBe('refused')
    expect(harness.fake.createCalls).toHaveLength(0)
  })
})

describe('the spawn cwd guard', () => {
  it('inherits the caller cwd when none is asked for', () => {
    expect(checkSpawnCwd({ callerCwd: '/work/project', root: '/state' })).toMatchObject({ ok: true, cwd: '/work/project' })
  })

  it('accepts the caller cwd, a path below it, and the state root', () => {
    const base = { callerCwd: '/work/project', root: '/state' }
    expect(checkSpawnCwd({ ...base, requested: '/work/project' }).ok).toBe(true)
    expect(checkSpawnCwd({ ...base, requested: '/work/project/sub' }).ok).toBe(true)
    expect(checkSpawnCwd({ ...base, requested: '/state/rooms/x/inbox' }).ok).toBe(true)
  })

  it('refuses a relative path and any unrelated absolute path', () => {
    const base = { callerCwd: '/work/project', root: '/state' }
    const relative = checkSpawnCwd({ ...base, requested: 'builds/out' })
    expect(relative.ok).toBe(false)
    expect(relative.reason).toContain('absolute')
    const elsewhere = checkSpawnCwd({ ...base, requested: '/home/user/secrets' })
    expect(elsewhere.ok).toBe(false)
    expect(elsewhere.reason).toContain('refused cwd')
    expect(elsewhere.reason).toContain('rooms.spawnCwdPrefixes')
  })

  it('a refused cwd means no create call at all', async () => {
    const room = await roomId()
    const result = await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'w', prompt: 'p', cwd: '/etc' }, author)
    expect(result.status).toBe('refused')
    expect(harness.fake.createCalls).toHaveLength(0)
  })

  it('session ids are crypto hex with the cortex prefix', () => {
    const id = newSessionId()
    expect(id).toMatch(/^cortex-[0-9a-f]{12}$/)
    expect(new Set([newSessionId(), newSessionId()]).size).toBe(2)
  })
})

describe('cortex_session_send', () => {
  it('refuses a target with no shared room, without inventing one', async () => {
    const stranger = makeFakeAgent('sess-stranger', { status: 'idle' })
    harness.fake.agents.set(stranger.id, stranger)
    const result = await callTool(harness.fake.tools.get('cortex_session_send'), { sessionId: 'sess-stranger', text: 'hi' }, author)
    expect(result.status).toBe('refused')
    expect(String(result.message)).toContain('not a member of any room')
    expect(stranger.received).toHaveLength(0)
  })

  it('refuses when the caller and the target share no room, even if the target is in one', async () => {
    await roomId()
    const other = await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'elsewhere' }, undefined)
    const otherId = String(other.roomId)
    // The listener lives only in 'elsewhere'; the author lives only in `room`.
    await harness.rooms.join(otherId, { label: 'listener', sessionId: 'sess-listener' })
    const listener = makeFakeAgent('sess-listener', { status: 'idle' })
    harness.fake.agents.set(listener.id, listener)
    const result = await callTool(harness.fake.tools.get('cortex_session_send'), { sessionId: 'sess-listener', text: 'cross-room' }, author)
    expect(result.status).toBe('refused')
    expect(String(result.message)).toContain('share no room')
    expect(listener.received).toHaveLength(0)
  })

  it('refuses to mail itself', async () => {
    const result = await callTool(harness.fake.tools.get('cortex_session_send'), { sessionId: 'sess-author', text: 'mirror' }, author)
    expect(result.status).toBe('refused')
    expect(String(result.message)).toContain('cortex_room_post')
  })

  it('an offline target keeps it unread and the result says so', async () => {
    const room = await roomId()
    await harness.rooms.join(room, { label: 'later', sessionId: 'sess-later' })
    const result = await callTool(harness.fake.tools.get('cortex_session_send'), { sessionId: 'sess-later', text: 'whenever you are back' }, author)
    expect(result.status).toBe('sent')
    expect(String(result.message)).toContain('stays unread')
    expect(result.counts).toMatchObject({ offline: 1, wake: 0 })
    expect(harness.rooms.renderFor('sess-later')).toContain('whenever you are back')
  })

  it('a live target is woken and the room records the message', async () => {
    const room = await roomId()
    const receiver = makeFakeAgent('sess-listener', { status: 'idle' })
    harness.fake.agents.set(receiver.id, receiver)
    await harness.rooms.join(room, { label: 'listener', sessionId: receiver.id })
    const result = await callTool(harness.fake.tools.get('cortex_session_send'), { sessionId: receiver.id, text: 'ping' }, author)
    expect(result.counts).toMatchObject({ wake: 1 })
    expect(receiver.received).toHaveLength(1)
    const transcript = await harness.rooms.read(room)
    expect(transcript.messages.map(message => message.text)).toEqual(['ping'])
  })
})

describe('the spawn cap counts live sessions, not history', () => {
  it('a spawned session that goes away frees the slot again', async () => {
    const room = await roomId()
    const before = liveSpawnedCount(id => harness.rooms.live(id) !== undefined)
    const result = await callTool(harness.fake.tools.get('cortex_session_spawn'), { roomId: room, label: 'worker', prompt: 'p' }, author)
    expect(result.status).toBe('spawned')
    expect(liveSpawnedCount(id => harness.rooms.live(id) !== undefined)).toBe(before + 1)
    // The host stops reporting it: the count falls back without any cleanup call.
    harness.fake.agents.delete(String(result.sessionId))
    expect(liveSpawnedCount(id => harness.rooms.live(id) !== undefined)).toBe(before)
    expect(recallSpawnedSession(String(result.sessionId))).toBe(true)
    expect(recallSpawnedSession(String(result.sessionId))).toBe(false)
  })
})
