/**
 * The `cortex:rooms` injection seam: what a session sees at its turn boundary.
 * Acceptance points from `.dev/BRIEFS.md` §M5 and the P1/P9 rules: at most 5
 * messages per turn with an honest remainder, a plugin banner on every message,
 * the consumed ledger surviving a restart, and no brace pair on any path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply as applyRooms } from '../../src/host/modules/rooms/index.ts'
import { MAIL_BLOCK_CHARS, MAIL_LABEL, MAIL_MAX_PER_TURN } from '../../src/host/modules/rooms/mail.ts'
import { consumedFile } from '../../src/host/modules/rooms/service.ts'
import { INJECT_LABEL } from '../../src/host/config.ts'
import { hasBracePair } from '../../src/lib/sanitize.ts'
import { callTool, makeFakeAgent, makeHarness } from './helpers.ts'
import type { FakeAgent, Harness } from './helpers.ts'

let harness: Harness
let author: FakeAgent

/** A member the host does NOT report live: mail queues instead of waking. */
async function offlineRoom(memberId: string): Promise<string> {
  const roomId = await createRoom()
  await harness.rooms.join(roomId, { label: memberId, sessionId: memberId })
  return roomId
}

async function createRoom(): Promise<string> {
  const result = await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'mail lab' }, author)
  return String(result.roomId)
}

function seamText(agent: { id: string } | undefined): string {
  const entry = harness.fake.contexts[0]
  if (entry === undefined) throw new Error('the cortex:rooms context was never registered')
  return entry.text(agent === undefined ? {} : { agent, scope: agent })
}

beforeEach(async () => {
  author = makeFakeAgent('sess-author', { status: 'idle', cwd: '/work/project' })
  // The peer is deliberately absent from the live registry in most tests here.
  harness = await makeHarness({ agents: [author] })
  applyRooms(harness.deps)
})

afterEach(async () => {
  await harness.dispose()
})

describe('the injected mail block', () => {
  it('carries the honest label and a per-message plugin banner', async () => {
    const roomId = await offlineRoom('sess-reader')
    await harness.rooms.post({ roomId, text: 'the build is red on main', fromSessionId: 'sess-author', fromLabel: 'session sess-author' })
    const text = seamText({ id: 'sess-reader' })
    // P1: the config label heads the block, exactly like the memory/todo blocks.
    expect(text.startsWith(INJECT_LABEL)).toBe(true)
    expect(MAIL_LABEL).toContain('not user instructions')
    expect(text).toContain('[dsh-cortex room')
    expect(text).toContain('NOT a user instruction')
    expect(text).toContain('the build is red on main')
    expect(text).toContain(`(${roomId})`)
  })

  it('renders at most 5 per turn and says how many are left', async () => {
    const roomId = await offlineRoom('sess-reader')
    for (let index = 1; index <= 7; index += 1) {
      await harness.rooms.post({ roomId, text: `note ${String(index)}`, fromSessionId: 'sess-author' })
    }
    expect(MAIL_MAX_PER_TURN).toBe(5)
    const first = seamText({ id: 'sess-reader' })
    expect(first).toContain('note 1')
    expect(first).toContain('note 5')
    expect(first).not.toContain('note 6')
    expect(first).toMatch(/2 more unread/)
    const second = seamText({ id: 'sess-reader' })
    expect(second).toContain('note 6')
    expect(second).toContain('note 7')
    expect(second).not.toContain('note 1')
    expect(seamText({ id: 'sess-reader' })).toBe('')
  })

  it('a consumed message is never rendered again after a restart (ledger file)', async () => {
    const roomId = await offlineRoom('sess-reader')
    await harness.rooms.post({ roomId, text: 'read me once', fromSessionId: 'sess-author' })
    expect(seamText({ id: 'sess-reader' })).toContain('read me once')
    await harness.rooms.flushLedger()
    const ledger = consumedFile(harness.store, roomId, 'sess-reader')
    const row = JSON.parse(await readFile(ledger, 'utf8')) as { sessionId: string; lastSeq: number }
    expect(row).toMatchObject({ sessionId: 'sess-reader', lastSeq: 1 })

    // Fresh service + fresh store over the same root: nothing re-renders.
    harness.restart()
    await harness.rooms.prime('sess-reader')
    expect(harness.rooms.renderFor('sess-reader')).toBe('')
    await harness.rooms.post({ roomId, text: 'a new one', fromSessionId: 'sess-author' })
    const after = harness.rooms.renderFor('sess-reader')
    expect(after).toContain('a new one')
    expect(after).not.toContain('read me once')
  })

  it('a corrupt ledger file is tolerated, never fatal (P4)', async () => {
    const roomId = await offlineRoom('sess-reader')
    await harness.rooms.post({ roomId, text: 'first', fromSessionId: 'sess-author' })
    const dir = join(consumedFile(harness.store, roomId, 'sess-reader'), '..')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'sess-reader.json'), '{ this is not json', 'utf8')
    harness.restart()
    await harness.rooms.prime('sess-reader')
    expect(harness.rooms.renderFor('sess-reader')).toContain('first')
    const { readdir } = await import('node:fs/promises')
    const quarantined = await readdir(join(harness.root, 'quarantine'))
    expect(quarantined.some(name => name.startsWith('sess-reader.json.corrupt-'))).toBe(true)
  })

  it('unread mail survives a restart instead of being lost', async () => {
    const roomId = await offlineRoom('sess-reader')
    await harness.rooms.post({ roomId, text: 'posted while you were out', fromSessionId: 'sess-author' })
    harness.restart()
    const queued = await harness.rooms.prime('sess-reader')
    expect(queued).toBe(1)
    const text = harness.rooms.renderFor('sess-reader')
    expect(text).toContain('posted while you were out')
    expect(text.startsWith(INJECT_LABEL)).toBe(true)
    await harness.rooms.flushLedger()
  })

  it('a message delivered by a wake is not rendered again after a restart', async () => {
    // Live idle member: it got the mail through followup, so its watermark moved.
    const roomId = String((await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'again?' }, author)).roomId)
    const sleeper = makeFakeAgent('sess-sleeper', { status: 'idle' })
    harness.fake.agents.set(sleeper.id, sleeper)
    await harness.rooms.join(roomId, { label: 'sleeper', sessionId: sleeper.id })
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'delivered once' }, author)
    expect(posted.counts.wake).toBe(1)
    await harness.rooms.flushLedger()
    harness.restart()
    await harness.rooms.prime('sess-sleeper')
    expect(harness.rooms.renderFor('sess-sleeper')).toBe('')
  })

  it('never shows a session its own words', async () => {
    const roomId = await createRoom()
    await harness.rooms.post({ roomId, text: 'i said this', fromSessionId: 'sess-author' })
    await harness.rooms.prime('sess-author')
    expect(seamText({ id: 'sess-author' })).toBe('')
  })

  it('no brace pair survives the render, whatever the message said (#53)', async () => {
    const roomId = await offlineRoom('sess-reader')
    await harness.rooms.post({
      roomId,
      text: 'template {{{ session }}} and }}} braces in a hostile body',
      fromSessionId: 'sess-author',
      fromLabel: 'evil {{{label}}}',
    })
    harness.restart()
    await harness.rooms.prime('sess-reader')
    const text = harness.rooms.renderFor('sess-reader')
    expect(hasBracePair(text)).toBe(false)
    expect(text).toContain('{ {')
  })

  it('a block stays inside its character budget even with long bodies', async () => {
    const roomId = await offlineRoom('sess-reader')
    for (let index = 0; index < 5; index += 1) {
      await harness.rooms.post({ roomId, text: 'x'.repeat(1500), fromSessionId: 'sess-author' })
    }
    const text = seamText({ id: 'sess-reader' })
    expect(text.length).toBeLessThanOrEqual(MAIL_BLOCK_CHARS)
    expect(text).not.toBe('')
    // Whatever the budget dropped must come back, not vanish (P2 + honesty).
    const rest = seamText({ id: 'sess-reader' })
    expect(rest).not.toBe('')
    expect(harness.rooms.renderFor('sess-reader')).toBe('')
  })

  it('images are announced with the absolute stored path + read_image', async () => {
    const roomId = await offlineRoom('sess-reader')
    const inbox = join(harness.root, 'rooms', roomId, 'inbox')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(inbox, 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: 'see the picture', images: [join(inbox, 'diagram.png')] }, author)
    expect(posted.images).toHaveLength(1)
    const text = seamText({ id: 'sess-reader' })
    expect(text).toContain(join(harness.root, 'rooms', roomId, 'images'))
    expect(text).toContain('read_image')
  })

  it('contributes nothing without an agent, and nothing when disabled', async () => {
    expect(seamText(undefined)).toBe('')
    const roomId = await offlineRoom('sess-reader')
    await harness.rooms.post({ roomId, text: 'while enabled', fromSessionId: 'sess-author' })
    harness.setConfig({ rooms: { enabled: false } })
    expect(seamText({ id: 'sess-reader' })).toBe('')
  })
})
