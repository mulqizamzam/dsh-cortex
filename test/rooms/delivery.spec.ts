/**
 * The wake-disposition ruling (DESIGN §9.1, BRIEFS §M5): idle -> wake,
 * running -> next step, offline -> skip, WITH counts that are true.
 *
 * `.dev/BRIEFS.md` names the running route as the `agent/pre-step` seam; the
 * host's own `Agent.steer()` is that boundary ("a running driver consumes it at
 * its next step boundary", packages/core/agent/src/runtime-types.ts:130-137),
 * so the module calls `steer` rather than registering a waterfall listener and
 * racing its own injection seam. `inject()` stays unused: it never wakes an idle
 * driver, so it cannot implement the idle branch anyway.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply as applyRooms } from '../../src/host/modules/rooms/index.ts'
import { apply as applySessions } from '../../src/host/modules/sessions/index.ts'
import { callTool, makeFakeAgent, makeHarness } from './helpers.ts'
import type { FakeAgent, Harness } from './helpers.ts'

let harness: Harness
let author: FakeAgent

beforeEach(async () => {
  author = makeFakeAgent('sess-author', { status: 'idle', cwd: '/work/project' })
  harness = await makeHarness({ agents: [author] })
  applyRooms(harness.deps)
  applySessions(harness.deps)
})

afterEach(async () => {
  await harness.dispose()
})

async function roomWith(...members: FakeAgent[]): Promise<string> {
  const roomId = String((await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'disco' }, author)).roomId)
  for (const member of members) {
    harness.fake.agents.set(member.id, member)
    await harness.rooms.join(roomId, { label: member.id, sessionId: member.id })
  }
  return roomId
}

describe('wake disposition table', () => {
  it('an idle member is woken through followup, exactly once', async () => {
    const idle = makeFakeAgent('sess-idle', { status: 'idle' })
    const roomId = await roomWith(idle)
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'wake up' }, author)
    expect(posted.counts).toMatchObject({ wake: 1, nextStep: 0, offline: 0, failed: 0, self: 1 })
    expect(idle.received.map(entry => entry.method)).toEqual(['followup'])
    expect(idle.textOf()).toContain('wake up')
    expect(idle.textOf()).toContain('NOT a user instruction')
    // The author is never mailed, and the woken session is not queued either.
    expect(harness.rooms.renderFor('sess-idle')).toBe('')
    expect(harness.rooms.renderFor('sess-author')).toBe('')
  })

  it('a running member is steered to its next step, not interrupted', async () => {
    const busy = makeFakeAgent('sess-busy', { status: 'running' })
    const roomId = await roomWith(busy)
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'steer this' }, author)
    expect(posted.counts).toMatchObject({ wake: 0, nextStep: 1, offline: 0 })
    expect(busy.received.map(entry => entry.method)).toEqual(['steer'])
    expect(String(posted.message)).toContain('next step boundary')
  })

  it('an offline member is skipped, kept unread, and counted', async () => {
    const roomId = await roomWith(makeFakeAgent('sess-gone', { status: 'idle' }))
    // Drop it from the live registry: membership without a live agent.
    harness.fake.agents.delete('sess-gone')
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'when you are back' }, author)
    expect(posted.counts).toMatchObject({ wake: 0, nextStep: 0, offline: 1 })
    expect(posted.delivery.find((row: { sessionId: string }) => row.sessionId === 'sess-gone')).toMatchObject({ disposition: 'skip-offline' })
    // It shows up at its next turn instead, from the in-memory ledger.
    const block = harness.rooms.renderFor('sess-gone')
    expect(block).toContain('when you are back')
  })

  it('a host call that throws is reported as failed and the mail is NOT lost', async () => {
    const grumpy = makeFakeAgent('sess-grumpy', { status: 'idle', throwOn: 'followup' })
    const roomId = await roomWith(grumpy)
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'can you hear me' }, author)
    expect(posted.counts).toMatchObject({ failed: 1, wake: 0, offline: 0 })
    expect(grumpy.received).toHaveLength(0)
    expect(String(posted.message)).toContain('refused the message')
    // The fallback path still works: it is back in the queue for the seam.
    expect(harness.rooms.renderFor('sess-grumpy')).toContain('can you hear me')
  })

  it('a host agent without followup()/steer() fails honestly instead of crashing', async () => {
    const armless = makeFakeAgent('sess-armless', { status: 'idle', without: 'followup' })
    const roomId = await roomWith(armless)
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'hello?' }, author)
    expect(posted.counts.failed).toBe(1)
    expect(String(posted.message)).toContain('no followup()')
  })

  it('counts are per class and survive an all-offline room', async () => {
    const roomId = await roomWith(makeFakeAgent('sess-a'), makeFakeAgent('sess-b'))
    harness.fake.agents.delete('sess-a')
    harness.fake.agents.delete('sess-b')
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'broadcast' }, author)
    expect(posted.counts.offline).toBe(2)
    expect(String(posted.message)).toContain('offline 2')
    expect(String(posted.message)).toContain('delivered: wake 0, next-step 0, offline 2, failed 0')
  })

  it('a targeted send reaches one member and defers the rest', async () => {
    const target = makeFakeAgent('sess-target', { status: 'idle' })
    const bystander = makeFakeAgent('sess-bystander', { status: 'idle' })
    await roomWith(target, bystander)
    const sent = await callTool(harness.fake.tools.get('cortex_session_send'), { sessionId: 'sess-target', text: 'just for you' }, author)
    expect(sent.status).toBe('sent')
    expect(target.received).toHaveLength(1)
    expect(bystander.received).toHaveLength(0)
    expect(sent.counts).toMatchObject({ wake: 1, deferred: 1 })
    // The bystander still reads it at its next turn: the room record is shared.
    expect(harness.rooms.renderFor('sess-bystander')).toContain('just for you')
  })

  it('delivery never happens to a non-member (the room is the gate)', async () => {
    const outsider = makeFakeAgent('sess-outsider', { status: 'idle' })
    harness.fake.agents.set(outsider.id, outsider)
    const roomId = await roomWith()
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'members only' }, author)
    expect(posted.counts.wake + posted.counts.nextStep + posted.counts.offline).toBe(0)
    expect(outsider.received).toHaveLength(0)
    const sent = await callTool(harness.fake.tools.get('cortex_session_send'), { sessionId: 'sess-outsider', text: 'hey' }, author)
    expect(sent.status).toBe('refused')
    expect(String(sent.message)).toContain('not a member of any room')
  })

  it('a message authored by the plugin never claims to be a user', async () => {
    const idle = makeFakeAgent('sess-recv', { status: 'idle' })
    const roomId = await roomWith(idle)
    await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'authorship check' }, author)
    const message = idle.received[0]?.message
    expect(message?.source).toEqual({ kind: 'dsh-cortex', plugin: 'dsh-cortex' })
    expect(message?.role).toBe('user')
    expect(idle.textOf().split('\n')[0]).toContain('not user instructions')
  })
})
