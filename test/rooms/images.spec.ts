/**
 * Image import discipline (DESIGN §2, HOST-API §6): v1 copies ONLY from inside
 * the plugin state root. These tests are the acceptance gate for the dangerous
 * direction — an agent naming a path it does not own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply as applyRooms } from '../../src/host/modules/rooms/index.ts'
import { IMAGE_EXTENSIONS, IMAGE_MAX_BYTES, checkRoomImage, ensureRoomInbox, importRoomImage, roomInboxDir } from '../../src/host/modules/rooms/images.ts'
import { CortexStore } from '../../src/host/store.ts'
import { callTool, fakePngBytes, makeFakeAgent, makeHarness, removeTempRoot } from './helpers.ts'
import type { FakeAgent, Harness } from './helpers.ts'

let harness: Harness
let author: FakeAgent
let outside: string

beforeEach(async () => {
  author = makeFakeAgent('sess-author', { status: 'idle', cwd: '/work/project' })
  harness = await makeHarness({ agents: [author] })
  applyRooms(harness.deps)
  outside = await mkdtemp(join(tmpdir(), 'dsh-cortex-outside-'))
})

afterEach(async () => {
  await harness.dispose()
  await removeTempRoot(outside)
})

// PARENT (B2 follow-up): the module's own state write must not bypass the
// store's schema gate — `ensureRoomInbox` is the room-creation path (service.ts:277).
it('the room inbox note goes through the gated store seam', async () => {
  const seamRoot = await mkdtemp(join(tmpdir(), 'dsh-cortex-seam-'))
  try {
    const store = new CortexStore({ root: seamRoot })
    expect((await store.init()).ok).toBe(true)
    await ensureRoomInbox(store, 'roomseam')
    expect(await readFile(join(roomInboxDir(store, 'roomseam'), 'README.txt'), 'utf8')).toContain('Drop files here')
    await writeFile(join(seamRoot, 'schema.json'), '{"version":2}', 'utf8')
    await store.init()
    await expect(ensureRoomInbox(store, 'roomseam2')).rejects.toThrow(/read-only/)
  } finally {
    await rm(seamRoot, { recursive: true, force: true })
  }
})

async function room(): Promise<string> {
  return String((await callTool(harness.fake.tools.get('cortex_room_create'), { title: 'images' }, author)).roomId)
}

describe('path containment', () => {
  it('refuses an absolute path outside the state root', async () => {
    const roomId = await room()
    const secret = join(outside, 'id_rsa')
    await writeFile(secret, 'PRIVATE KEY MATERIAL')
    const check = await checkRoomImage(harness.store, roomId, secret)
    expect(check.ok).toBe(false)
    expect(check.message).toContain('outside the plugin state root')
    const images = await readdir(join(harness.root, 'rooms', roomId, 'images'))
    expect(images).toEqual([])
    // Nothing was created, and the foreign file was not read or copied.
    expect(await readFile(secret, 'utf8')).toBe('PRIVATE KEY MATERIAL')
  })

  it('refuses a relative path, and names the inbox instead', async () => {
    const roomId = await room()
    const check = await checkRoomImage(harness.store, roomId, 'rooms/../etc/passwd')
    expect(check.ok).toBe(false)
    expect(check.message).toContain('absolute')
    expect(check.message).toContain(join(harness.root, 'rooms', roomId, 'inbox'))
  })

  it('refuses a `..` escape that still starts with the root', async () => {
    const roomId = await room()
    const escape = join(harness.root, 'rooms', '..' + '/../..')
    const check = await checkRoomImage(harness.store, roomId, resolve(escape, 'etc', 'shadow'))
    expect(check.ok).toBe(false)
    expect(check.message).toContain('outside the plugin state root')
  })

  it('refuses a non-string and an empty string', async () => {
    const roomId = await room()
    expect((await checkRoomImage(harness.store, roomId, 42)).ok).toBe(false)
    expect((await checkRoomImage(harness.store, roomId, '   ')).ok).toBe(false)
  })

  it('refuses a non-whitelisted type and an oversize file', async () => {
    const roomId = await room()
    const inbox = join(harness.root, 'rooms', roomId, 'inbox')
    await writeFile(join(inbox, 'notes.txt'), 'plain text')
    const wrongType = await checkRoomImage(harness.store, roomId, join(inbox, 'notes.txt'))
    expect(wrongType.ok).toBe(false)
    expect(wrongType.message).toContain('not whitelisted')
    expect(IMAGE_EXTENSIONS).toContain('png')

    const bigPath = join(inbox, 'big.png')
    const sparse = new Uint8Array(1024)
    sparse.set([0x89, 0x50, 0x4e, 0x47], 0)
    const { writeFile: wf, stat } = await import('node:fs/promises')
    await wf(bigPath, sparse)
    // Truncate UP to pretend a big file without allocating 8 MiB of payload.
    const { truncate } = await import('node:fs/promises')
    await truncate(bigPath, IMAGE_MAX_BYTES + 10)
    expect((await stat(bigPath)).size).toBe(IMAGE_MAX_BYTES + 10)
    const tooBig = await checkRoomImage(harness.store, roomId, bigPath)
    expect(tooBig.ok).toBe(false)
    expect(tooBig.message).toContain('the cap is')
  })

  it('refuses an unreadable file inside the root', async () => {
    const roomId = await room()
    const check = await checkRoomImage(harness.store, roomId, join(harness.root, 'rooms', roomId, 'inbox', 'ghost.png'))
    expect(check.ok).toBe(false)
    expect(check.message).toContain('no readable file')
  })
})

describe('the copy path', () => {
  it('copies a state-root file into rooms/<id>/images and stores a relative path', async () => {
    const roomId = await room()
    const inbox = join(harness.root, 'rooms', roomId, 'inbox')
    const source = join(inbox, 'diagram.png')
    await writeFile(source, fakePngBytes(256))
    const imported = await importRoomImage(harness.store, roomId, source)
    expect(imported.ok).toBe(true)
    expect(imported.rel).toMatch(/^images\/[0-9a-f]{12}-diagram\.png$/)
    const copied = await readFile(join(harness.root, 'rooms', roomId, imported.rel as string))
    expect(copied.length).toBe(256)
    // The original stays where it was (we copy, we do not move).
    expect(await readFile(source)).toBeTruthy()
  })

  it('a post lists accepted images and refused ones separately, then still posts', async () => {
    const roomId = await room()
    const inbox = join(harness.root, 'rooms', roomId, 'inbox')
    await writeFile(join(inbox, 'good.png'), fakePngBytes())
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), {
      roomId,
      text: 'one good, one foreign',
      images: [join(inbox, 'good.png'), join(outside, 'private.png')],
    }, author)
    expect(posted.status).toBe('posted')
    expect(posted.images).toHaveLength(1)
    expect(posted.refusedImages).toHaveLength(1)
    expect(String(posted.message)).toContain('refused 1 image path')
    const transcript = await harness.rooms.read(roomId)
    expect(transcript.messages[0]?.images).toHaveLength(1)
    expect(transcript.messages[0]?.images[0]).toMatch(/^images\//)
  })

  it('an image-only post with no accepted image is refused', async () => {
    const roomId = await room()
    const posted = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId, text: '', images: [join(outside, 'x.png')] }, author)
    expect(posted.status).toBe('refused')
    expect(String(posted.message)).toContain('no image was accepted')
  })

  it('cross-room smuggling is impossible: a path in ANOTHER room is inside the root but still copied fresh', async () => {
    // A file already stored under room A may be re-posted into room B (it is
    // plugin-owned data, already inside the root). This asserts the copy lands
    // in B, so a reader in B never resolves a path that points at A.
    const roomA = await room()
    const roomB = await room()
    const inboxA = join(harness.root, 'rooms', roomA, 'inbox')
    await writeFile(join(inboxA, 'shared.png'), fakePngBytes(128))
    const inA = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId: roomA, text: 'in A', images: [join(inboxA, 'shared.png')] }, author)
    const inB = await callTool(harness.fake.tools.get('cortex_room_post'), { roomId: roomB, text: 'in B', images: [join(harness.root, 'rooms', roomA, inA.images[0])] }, author)
    expect(inB.status).toBe('posted')
    const bTranscript = await harness.rooms.read(roomB)
    const rel = bTranscript.messages[0]?.images[0] as string
    expect(rel).not.toContain('..')
    expect((await readFile(join(harness.root, 'rooms', roomB, rel))).length).toBe(128)
    await rm(join(harness.root, 'rooms', roomA), { recursive: true, force: true })
    // Room B kept its own bytes; the deleted source changes nothing for it.
    expect((await readFile(join(harness.root, 'rooms', roomB, rel))).length).toBe(128)
  })
})
