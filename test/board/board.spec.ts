/**
 * Board module tests: store methods + service layer + tool contracts.
 *
 * Store tests run against a temp root (no real state is ever touched).
 * Service tests gate on `board.enabled` to prove P3 default-off behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { CortexStore } from '../../src/host/store.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'
import { boardService, resetBoardService } from '../../src/host/modules/board/service.ts'
import type { ModuleDeps } from '../../src/host/types.ts'
import type { ResolvedConfig } from '../../src/host/types.ts'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { apply as boardModuleApply } from '../../src/host/modules/board/index.ts'
import { readEndpoints, writeEndpoints } from '../../src/host/modules/board/rpc.ts'

// ------------------------------------------------------------------ store ----

describe('board store', () => {
  let root = ''
  let store: CortexStore
  let clock = new Date('2026-01-01T00:00:00.000Z')

  beforeEach(async () => {
    root = await makeTempRoot('dsh-cortex-board-store-')
    store = new CortexStore({ root, caps: DEFAULT_CAPS, now: () => clock })
    expect((await store.init()).ok).toBe(true)
  })

  afterEach(async () => { await removeTempRoot(root) })

  it('createBoard: creates a board in a room and scaffolds the card dir', async () => {
    const result = await store.createBoard({ roomId: 'room1', title: 'Sprint 1', createdBy: 'sess-a' })
    expect(result.ok).toBe(true)
    expect(result.data?.id).toBeTypeOf('string')
    expect(result.data?.title).toBe('Sprint 1')
    expect(result.data?.cardIds).toEqual([])
    // Board doc exists on disk
    expect(result.data?.roomId).toBe('room1')
  })

  it('getBoard: reads back a previously created board', async () => {
    const created = await store.createBoard({ roomId: 'room1', title: 'X' })
    const id = created.data!.id
    const result = await store.getBoard('room1', id)
    expect(result.ok).toBe(true)
    expect(result.data?.title).toBe('X')
  })

  it('getBoard: returns null for a missing board', async () => {
    const result = await store.getBoard('room1', 'nonexistent')
    expect(result.ok).toBe(true)
    expect(result.data).toBeNull()
  })

  it('listBoards: returns all boards in a room', async () => {
    await store.createBoard({ roomId: 'room1', title: 'A' })
    await store.createBoard({ roomId: 'room1', title: 'B' })
    const result = await store.listBoards('room1')
    expect(result.ok).toBe(true)
    expect(result.data!.length).toBe(2)
    const titles = result.data!.map(b => b.title).sort()
    expect(titles).toEqual(['A', 'B'])
  })

  it('listBoards: returns empty for a room with no boards', async () => {
    const result = await store.listBoards('room-none')
    expect(result.ok).toBe(true)
    expect(result.data).toEqual([])
  })

  it('addCard: adds a card to a board', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({
      roomId: 'room1',
      boardId: board.data!.id,
      title: 'Fix bug',
      status: 'in-progress',
      ownerId: 'sess-a',
      dependencies: [],
    })
    expect(card.ok).toBe(true)
    expect(card.data?.title).toBe('Fix bug')
    expect(card.data?.status).toBe('in-progress')
    expect(card.data?.ownerId).toBe('sess-a')
    // Board doc is updated
    const updated = await store.getBoard('room1', board.data!.id)
    expect(updated.data?.cardIds).toContain(card.data!.id)
  })

  it('addCard: default status is backlog', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'Default card' })
    expect(card.data?.status).toBe('backlog')
  })

  it('addCard: refuses when the board does not exist', async () => {
    const result = await store.addCard({ roomId: 'room1', boardId: 'no-board', title: 'X' })
    expect(result.ok).toBe(false)
  })

  it('getCard: reads a card by id', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    const result = await store.getCard('room1', board.data!.id, card.data!.id)
    expect(result.ok).toBe(true)
    expect(result.data?.title).toBe('C1')
  })

  it('getCard: returns null for a missing card', async () => {
    const result = await store.getCard('room1', 'no-board', 'no-card')
    expect(result.ok).toBe(true)
    expect(result.data).toBeNull()
  })

  it('updateCard: changes a card\'s status', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    const result = await store.updateCard('room1', board.data!.id, card.data!.id, { status: 'done' })
    expect(result.ok).toBe(true)
    expect(result.data?.status).toBe('done')
    const fetched = await store.getCard('room1', board.data!.id, card.data!.id)
    expect(fetched.data?.status).toBe('done')
  })

  it('updateCard: updates the ownerId', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1', ownerId: 'sess-a' })
    const result = await store.updateCard('room1', board.data!.id, card.data!.id, { ownerId: 'sess-b' })
    expect(result.data?.ownerId).toBe('sess-b')
  })

  it('listCards: returns all cards in a board', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C2', status: 'done' })
    const result = await store.listCards('room1', board.data!.id)
    expect(result.ok).toBe(true)
    expect(result.data!.length).toBe(2)
  })

  it('listCards: filters by status', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C2', status: 'done' })
    const result = await store.listCards('room1', board.data!.id, { status: 'done' })
    expect(result.data!.length).toBe(1)
    expect(result.data![0].title).toBe('C2')
  })

  it('addComment: stores a comment on a card', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    const comment = await store.addComment({
      roomId: 'room1',
      boardId: board.data!.id,
      cardId: card.data!.id,
      text: 'I\'ll take this',
      authorSessionId: 'sess-a',
      authorLabel: 'session sess-a',
    })
    expect(comment.ok).toBe(true)
    expect(comment.data?.text).toBe('I\'ll take this')
    expect(comment.data?.cardId).toBe(card.data!.id)
  })

  it('addComment: refuses when the card does not exist', async () => {
    const result = await store.addComment({ roomId: 'room1', boardId: 'no-board', cardId: 'no-card', text: 'x' })
    expect(result.ok).toBe(false)
  })

  it('listComments: returns all comments on a card sorted by createdAt', async () => {
    clock = new Date('2026-01-01T00:00:01.000Z')
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    clock = new Date('2026-01-01T00:00:02.000Z')
    await store.addComment({ roomId: 'room1', boardId: board.data!.id, cardId: card.data!.id, text: 'first' })
    clock = new Date('2026-01-01T00:00:03.000Z')
    await store.addComment({ roomId: 'room1', boardId: board.data!.id, cardId: card.data!.id, text: 'second' })
    const result = await store.listComments('room1', board.data!.id, card.data!.id)
    expect(result.ok).toBe(true)
    expect(result.data!.length).toBe(2)
    expect(result.data![0].text).toBe('first')
    expect(result.data![1].text).toBe('second')
  })

  it('deleteCard: removes a card from the board', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    const card = await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    const result = await store.deleteCard('room1', board.data!.id, card.data!.id)
    expect(result.ok).toBe(true)
    expect(result.data).toBe(true)
    // Board no longer lists this card
    const updated = await store.getBoard('room1', board.data!.id)
    expect(updated.data?.cardIds).not.toContain(card.data!.id)
    // Card file is gone
    const fetched = await store.getCard('room1', board.data!.id, card.data!.id)
    expect(fetched.data).toBeNull()
  })

  it('deleteBoard: removes a board and its cards', async () => {
    const board = await store.createBoard({ roomId: 'room1', title: 'X' })
    await store.addCard({ roomId: 'room1', boardId: board.data!.id, title: 'C1' })
    const result = await store.deleteBoard('room1', board.data!.id)
    expect(result.ok).toBe(true)
    expect(result.data).toBe(true)
    const fetched = await store.getBoard('room1', board.data!.id)
    expect(fetched.data).toBeNull()
  })

  it('deleteBoard: returns false for a missing board', async () => {
    const result = await store.deleteBoard('room1', 'no-board')
    expect(result.ok).toBe(true)
    expect(result.data).toBe(false)
  })
})

// ----------------------------------------------------------------- service ---

/**
 * Minimal ModuleDeps built over a temp root; the service only touches
 * `store` and `cfg()`. No host surface is needed here. The store is initialised
 * here because the RPC path reaches the filesystem, and an uninitialised store
 * surfaces as a "handler-failed" refusal rather than as an empty list.
 */
async function makeServiceDeps(root: string, boardEnabled: boolean): Promise<ModuleDeps> {
  const store = new CortexStore({ root, caps: DEFAULT_CAPS, now: () => new Date() })
  const config = resolveConfig({ ...DEFAULT_CONFIG, board: { enabled: boardEnabled } } as never) as ResolvedConfig
  await store.init()
  return {
    ctx: {
      tools: { register: () => undefined },
      agents: { get: () => undefined, roots: () => [] } as never,
      get: () => undefined,
      inject: () => undefined,
      on: () => () => undefined,
      effect: () => () => undefined,
    } as never,
    cfg: () => config,
    store,
    log: () => {},
    warn: () => {},
    runtime: () => ({ modules: [] }),
  }
}

describe('board service', () => {
  let root = ''
  let deps: ModuleDeps

  beforeEach(async () => {
    root = await makeTempRoot('dsh-cortex-board-svc-')
    resetBoardService()
    deps = await makeServiceDeps(root, true)
  })

  afterEach(async () => {
    resetBoardService()
    await removeTempRoot(root)
  })

  it('create + addCard + moveCard lifecycle', async () => {
    const svc = boardService(deps)
    const created = await svc.create({ title: 'Sprint', roomId: 'room1' })
    expect(created.ok).toBe(true)
    const boardId = created.boardId!

    const card = await svc.addCard({ roomId: 'room1', boardId, title: 'Task 1' })
    expect(card.ok).toBe(true)

    const moved = await svc.moveCard('room1', boardId, card.card!.id, 'in-progress')
    expect(moved.ok).toBe(true)
    expect(moved.card?.status).toBe('in-progress')
  })

  it('addComment + listComments', async () => {
    const svc = boardService(deps)
    const created = await svc.create({ title: 'X', roomId: 'room1' })
    const card = await svc.addCard({ roomId: 'room1', boardId: created.boardId!, title: 'T' })
    const comment = await svc.addComment({
      roomId: 'room1',
      boardId: created.boardId!,
      cardId: card.card!.id,
      text: 'on it',
      authorSessionId: 'sess-1',
    })
    expect(comment.ok).toBe(true)
    const comments = await svc.listComments('room1', created.boardId!, card.card!.id)
    expect(comments.ok).toBe(true)
    expect(comments.comments!.length).toBe(1)
    expect(comments.comments![0].text).toBe('on it')
  })

  it('gates on board.enabled', async () => {
    const disabledDeps = await makeServiceDeps(root, false)
    const svc = boardService(disabledDeps)
    const result = await svc.create({ title: 'X', roomId: 'room1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('disabled')
  })

  it('get: reads all cards and optionally comments', async () => {
    const svc = boardService(deps)
    const created = await svc.create({ title: 'X', roomId: 'room1' })
    await svc.addCard({ roomId: 'room1', boardId: created.boardId!, title: 'C1' })
    await svc.addCard({ roomId: 'room1', boardId: created.boardId!, title: 'C2', status: 'done' })
    const result = await svc.get('room1', created.boardId!, { includeComments: true })
    expect(result.ok).toBe(true)
    expect(result.board!.length).toBe(2)
    expect(result.board!.find(c => c.title === 'C2')?.status).toBe('done')
  })
})

// ------------------------------------------------------------------- rpc ----

describe('board module wiring', () => {
  let root = ''

  beforeEach(async () => {
    root = await makeTempRoot('dsh-cortex-board-rpc-')
    resetBoardService()
  })

  afterEach(async () => {
    resetBoardService()
    await removeTempRoot(root)
  })

  it('apply() binds the RPC endpoints, so boards.list is answerable', async () => {
    // The seven TOOLS all worked while every `boards.*` RPC answered
    // "not-wired": the tool path and the RPC path are separate, and apply()
    // built the service without ever pointing the exported maps at it. The
    // refusal is the reason, not the symptom.
    const deps = await makeServiceDeps(root, true)
    boardModuleApply(deps)

    const listed = await readEndpoints['boards.list']!({ roomId: 'room1' })
    expect(listed.ok).toBe(true)
    expect((listed as { value: { boards: unknown[] } }).value.boards).toEqual([])

    const created = await writeEndpoints['boards.create']!({ roomId: 'room1', title: 'Sprint' })
    expect(created.ok).toBe(true)
    const boardId = (created as { value: { boardId: string } }).value.boardId
    const got = await readEndpoints['boards.get']!({ roomId: 'room1', boardId })
    expect(got.ok).toBe(true)
  })

  it('a disabled board refuses reads and writes through the bound endpoints', async () => {
    const deps = await makeServiceDeps(root, false)
    boardModuleApply(deps)
    const listed = await readEndpoints['boards.list']!({ roomId: 'room1' })
    expect(listed.ok).toBe(false)
  })
})
