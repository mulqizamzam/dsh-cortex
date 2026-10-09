/**
 * D-02 board auto-unblock tests.
 *
 * `moveCard(cardId, 'done')` with `board.autoNotify=true` must:
 *  - move every `backlog` card that depends on it to `in-progress`
 *  - attach a machine-authored comment naming the unblocker
 *  - leave `in-progress`/`done` dependents alone
 *  - be silent (no cascade) when `board.autoNotify` is off
 *  - terminate safely on circular dependencies
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { CortexStore } from '../../src/host/store.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'
import { boardService, resetBoardService } from '../../src/host/modules/board/service.ts'
import type { ModuleDeps, ResolvedConfig } from '../../src/host/types.ts'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'

async function makeDeps(root: string, autoNotify: boolean): Promise<ModuleDeps> {
  const store = new CortexStore({ root, caps: DEFAULT_CAPS, now: () => new Date() })
  const config = resolveConfig({
    ...DEFAULT_CONFIG,
    board: { enabled: true, autoNotify },
  } as never) as ResolvedConfig
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

describe('board auto-unblock (D-02)', () => {
  let root = ''

  beforeEach(async () => {
    root = await makeTempRoot('dsh-cortex-unblock-')
    resetBoardService()
  })

  afterEach(async () => {
    resetBoardService()
    await removeTempRoot(root)
  })

  it('moving a card to done unblocks backlog dependents when autoNotify=true', async () => {
    const deps = await makeDeps(root, true)
    const svc = boardService(deps)
    const board = await svc.create({ title: 'Unblock', roomId: 'room-u' })
    const boardId = board.boardId!

    // a ← b (b depends on a)
    const a = await svc.addCard({ roomId: 'room-u', boardId, title: 'a' })
    const b = await svc.addCard({ roomId: 'room-u', boardId, title: 'b', dependencies: [a.card!.id] })

    // Move a → done. With autoNotify on, b should be unblocked.
    const result = await svc.moveCard('room-u', boardId, a.card!.id, 'done')
    expect(result.ok).toBe(true)
    expect(result.unblocked).toEqual([b.card!.id])
    expect(result.message).toContain('unblocked 1')

    // b should now be in-progress
    const bAfter = await svc.get('room-u', boardId)
    const bCard = bAfter.board!.find(c => c.id === b.card!.id)!
    expect(bCard.status).toBe('in-progress')

    // The unblock comment should be on b
    const comments = await svc.listComments('room-u', boardId, b.card!.id)
    expect(comments.ok).toBe(true)
    expect(comments.comments!.some(c => c.text.includes('unblocked'))).toBe(true)
  })

  it('moving a card to done does NOT touch in-progress or done dependents', async () => {
    const deps = await makeDeps(root, true)
    const svc = boardService(deps)
    const board = await svc.create({ title: 'X', roomId: 'room-u2' })
    const boardId = board.boardId!

    const a = await svc.addCard({ roomId: 'room-u2', boardId, title: 'a' })
    const b = await svc.addCard({ roomId: 'room-u2', boardId, title: 'b', dependencies: [a.card!.id], status: 'in-progress' })
    const c = await svc.addCard({ roomId: 'room-u2', boardId, title: 'c', dependencies: [a.card!.id], status: 'done' })

    const result = await svc.moveCard('room-u2', boardId, a.card!.id, 'done')
    expect(result.ok).toBe(true)
    // b and c are not in backlog, so they should NOT be in unblocked
    expect(result.unblocked).toEqual([])

    // b is still in-progress, c is still done
    const view = await svc.get('room-u2', boardId)
    expect(view.board!.find(x => x.id === b.card!.id)?.status).toBe('in-progress')
    expect(view.board!.find(x => x.id === c.card!.id)?.status).toBe('done')
  })

  it('autoNotify=false means no cascade — b stays in backlog', async () => {
    const deps = await makeDeps(root, false)
    const svc = boardService(deps)
    const board = await svc.create({ title: 'off', roomId: 'room-u3' })
    const boardId = board.boardId!

    const a = await svc.addCard({ roomId: 'room-u3', boardId, title: 'a' })
    const b = await svc.addCard({ roomId: 'room-u3', boardId, title: 'b', dependencies: [a.card!.id] })

    const result = await svc.moveCard('room-u3', boardId, a.card!.id, 'done')
    expect(result.ok).toBe(true)
    // autoNotify off: no unblocked array, b stays in backlog
    expect(result.unblocked ?? []).toEqual([])

    const view = await svc.get('room-u3', boardId)
    expect(view.board!.find(c => c.id === b.card!.id)?.status).toBe('backlog')
  })

  it('non-done moves do not trigger a cascade', async () => {
    const deps = await makeDeps(root, true)
    const svc = boardService(deps)
    const board = await svc.create({ title: 'np', roomId: 'room-u4' })
    const boardId = board.boardId!

    const a = await svc.addCard({ roomId: 'room-u4', boardId, title: 'a' })
    const b = await svc.addCard({ roomId: 'room-u4', boardId, title: 'b', dependencies: [a.card!.id] })

    // Move a → in-progress (not done): no cascade
    const result = await svc.moveCard('room-u4', boardId, a.card!.id, 'in-progress')
    expect(result.ok).toBe(true)
    expect(result.unblocked ?? []).toEqual([])

    const view = await svc.get('room-u4', boardId)
    expect(view.board!.find(c => c.id === b.card!.id)?.status).toBe('backlog')
  })

  it('multiple dependents are all unblocked in one move', async () => {
    const deps = await makeDeps(root, true)
    const svc = boardService(deps)
    const board = await svc.create({ title: 'multi', roomId: 'room-u5' })
    const boardId = board.boardId!

    const a = await svc.addCard({ roomId: 'room-u5', boardId, title: 'a' })
    const b = await svc.addCard({ roomId: 'room-u5', boardId, title: 'b', dependencies: [a.card!.id] })
    const c = await svc.addCard({ roomId: 'room-u5', boardId, title: 'c', dependencies: [a.card!.id] })
    const d = await svc.addCard({ roomId: 'room-u5', boardId, title: 'd', dependencies: [b.card!.id] }) // d depends on b, not a

    const result = await svc.moveCard('room-u5', boardId, a.card!.id, 'done')
    expect(result.ok).toBe(true)
    // b and c are direct dependents of a; d depends on b, so d is NOT unblocked by this move
    expect(result.unblocked!.length).toBe(2)
    expect(result.unblocked!).toContain(b.card!.id)
    expect(result.unblocked!).toContain(c.card!.id)
    expect(result.unblocked!).not.toContain(d.card!.id)
  })

  it('a card with self-dependency is skipped safely', async () => {
    const deps = await makeDeps(root, true)
    const svc = boardService(deps)
    const board = await svc.create({ title: 'self', roomId: 'room-u6' })
    const boardId = board.boardId!

    const a = await svc.addCard({ roomId: 'room-u6', boardId, title: 'a' })
    // b depends on a; when a reaches done, b unblocks
    const b = await svc.addCard({ roomId: 'room-u6', boardId, title: 'b', dependencies: [a.card!.id] })
    const result = await svc.moveCard('room-u6', boardId, a.card!.id, 'done')
    expect(result.ok).toBe(true)
    expect(result.unblocked).toEqual([b.card!.id])
  })
})
