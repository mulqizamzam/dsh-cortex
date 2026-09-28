/**
 * Board service: the domain layer for the inter-agent task board.
 *
 * A board is scoped to a room. Cards have a 3-column status (backlog | in-progress | done),
 * an optional owner session, optional dependency ids, and a comment thread.
 *
 * Tool contract (DESIGN §4): every description is static and brace-pair-free;
 * every result passes `neutralizeDeep`; failures are sentences not stacks.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import { isSafeKey, newId } from '../../../lib/ids.ts'
import type { ModuleDeps, BoardCard, BoardComment, BoardStatus } from '../../types.ts'
import type { HostAgent } from '../../dsh.ts'

type Args = Record<string, unknown>

/** How many comments are surfaced per card in a board.get response. */
export const COMMENT_PAGE = 50

export interface BoardOutcome {
  ok: boolean
  message: string
  boardId?: string
  roomId?: string
}

export interface CardOutcome {
  ok: boolean
  message: string
  card?: BoardCard
}

export interface CommentOutcome {
  ok: boolean
  message: string
  comment?: BoardComment
}

function refused(message: string): BoardOutcome {
  return { ok: false, message: neutralize(message) }
}

function cardRefused(message: string): CardOutcome {
  return { ok: false, message: neutralize(message) }
}

function commentRefused(message: string): CommentOutcome {
  return { ok: false, message: neutralize(message) }
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function statusArg(value: unknown): BoardStatus | undefined {
  if (value !== 'backlog' && value !== 'in-progress' && value !== 'done') return undefined
  return value as BoardStatus
}

function listIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string' && isSafeKey(item)).slice(0, 20)
}

/**
 * Board service. Owns the business logic; tools and rpc handlers delegate here.
 * One instance per deps (singleton cached by the module).
 */
export class BoardService {
  private readonly deps: ModuleDeps

  constructor(deps: ModuleDeps) {
    this.deps = deps
  }

  /** `board.enabled` from config — callers gate on this before invoking methods. */
  get enabled(): boolean {
    return this.deps.cfg().board?.enabled === true
  }

  /** Caller's session id (from the agent handle), or undefined for headless/UI paths. */
  ownSessionId(agent?: HostAgent): string | undefined {
    if (agent === undefined) return undefined
    return typeof agent.id === 'string' && agent.id !== '' ? agent.id : undefined
  }

  // ---------------------------------------------------------- board CRUD ----

  async create(input: { title: string; roomId: string; createdBy?: string }): Promise<BoardOutcome> {
    if (!this.enabled) return refused('board is disabled by config (board.enabled = false)')
    const title = input.title.trim()
    if (title === '') return refused('a board needs a non-empty title')
    const roomId = stringArg(input.roomId)
    if (roomId === '' || !isSafeKey(roomId)) return refused('roomId must be a valid room id')
    const result = await this.deps.store.createBoard({ roomId, title, ...(input.createdBy ? { createdBy: input.createdBy } : {}) })
    if (!result.ok || result.data === null || result.data === undefined) {
      return refused(`could not create board: ${result.error ?? 'unknown'}`)
    }
    return { ok: true, message: `board ${result.data.id} created in room ${roomId}`, boardId: result.data.id, roomId }
  }

  async list(roomId: string): Promise<{ ok: boolean; boards: Array<{ id: string; title: string; cardCount: number; createdAt: string }>; message: string }> {
    if (!this.enabled) return { ok: false, boards: [], message: 'board is disabled by config' }
    if (!isSafeKey(roomId)) return { ok: false, boards: [], message: 'invalid roomId' }
    const boards = await this.deps.store.listBoards(roomId)
    if (!boards.ok) return { ok: false, boards: [], message: boards.error ?? 'unknown' }
    return {
      ok: true,
      message: `${boards.data.length} board(s) in room ${roomId}`,
      boards: boards.data.map(b => ({
        id: b.id,
        title: neutralize(clampText(b.title, 60)),
        cardCount: b.cardIds.length,
        createdAt: b.createdAt,
      })),
    }
  }

  async get(roomId: string, boardId: string, options?: { includeComments?: boolean; commentLimit?: number }): Promise<{
    ok: boolean
    board?: BoardCard[]
    comments?: BoardComment[]
    message: string
  }> {
    if (!this.enabled) return { ok: false, message: 'board is disabled by config' }
    if (!isSafeKey(roomId) || !isSafeKey(boardId)) return { ok: false, message: 'invalid roomId or boardId' }
    const board = await this.deps.store.getBoard(roomId, boardId)
    if (!board.ok || board.data === null || board.data === undefined) {
      return { ok: false, message: `board ${boardId} not found in room ${roomId}` }
    }
    const cards = await this.deps.store.listCards(roomId, boardId)
    if (!cards.ok) return { ok: false, message: `could not read cards: ${cards.error ?? 'unknown'}` }
    const result: { ok: boolean; board?: BoardCard[]; comments?: BoardComment[]; message: string } = {
      ok: true,
      board: cards.data,
      message: `board ${boardId}: ${cards.data.length} card(s) in room ${roomId}`,
    }
    if (options?.includeComments === true) {
      const cardIds = cards.data.map(c => c.id)
      const comments: BoardComment[] = []
      for (const cardId of cardIds) {
        const c = await this.deps.store.listComments(roomId, boardId, cardId, { limit: options.commentLimit ?? COMMENT_PAGE })
        if (c.ok && c.data) comments.push(...c.data)
      }
      result.comments = comments
    }
    return result
  }

  async delete(roomId: string, boardId: string): Promise<BoardOutcome> {
    if (!this.enabled) return refused('board is disabled by config')
    if (!isSafeKey(roomId) || !isSafeKey(boardId)) return refused('invalid roomId or boardId')
    const result = await this.deps.store.deleteBoard(roomId, boardId)
    if (!result.ok) return refused(`could not delete board ${boardId}: ${result.error ?? 'unknown'}`)
    if (result.data !== true) return refused(`board ${boardId} not found`)
    return { ok: true, message: `board ${boardId} deleted`, boardId, roomId }
  }

  // ----------------------------------------------------------- card CRUD ----

  async addCard(input: {
    roomId: string
    boardId: string
    title: string
    description?: string
    status?: BoardStatus
    ownerId?: string
    dependencies?: string[]
  }): Promise<CardOutcome> {
    if (!this.enabled) return cardRefused('board is disabled by config')
    const roomId = stringArg(input.roomId)
    const boardId = stringArg(input.boardId)
    const title = input.title?.trim() ?? ''
    if (roomId === '' || !isSafeKey(roomId)) return cardRefused('roomId is required')
    if (boardId === '' || !isSafeKey(boardId)) return cardRefused('boardId is required')
    if (title === '') return cardRefused('a card needs a non-empty title')
    const status = input.status !== undefined ? statusArg(input.status) : undefined
    const dependencies = listIds(input.dependencies)
    const result = await this.deps.store.addCard({
      roomId,
      boardId,
      title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      dependencies,
    })
    if (!result.ok || result.data === null || result.data === undefined) {
      return cardRefused(`could not add card: ${result.error ?? 'unknown'}`)
    }
    return { ok: true, message: `card ${result.data.id} added`, card: result.data }
  }

  async moveCard(roomId: string, boardId: string, cardId: string, status: BoardStatus): Promise<CardOutcome> {
    if (!this.enabled) return cardRefused('board is disabled by config')
    if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return cardRefused('invalid id(s)')
    const card = await this.deps.store.getCard(roomId, boardId, cardId)
    if (!card.ok || card.data === null || card.data === undefined) {
      return cardRefused(`card ${cardId} not found in board ${boardId}`)
    }
    const updated = await this.deps.store.updateCard(roomId, boardId, cardId, { status })
    if (!updated.ok || updated.data === null || updated.data === undefined) {
      return cardRefused(`could not move card ${cardId}: ${updated.error ?? 'unknown'}`)
    }
    return { ok: true, message: `card ${cardId} moved to ${status}`, card: updated.data }
  }

  async setOwner(roomId: string, boardId: string, cardId: string, ownerId: string): Promise<CardOutcome> {
    if (!this.enabled) return cardRefused('board is disabled by config')
    if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return cardRefused('invalid id(s)')
    const card = await this.deps.store.getCard(roomId, boardId, cardId)
    if (!card.ok || card.data === null || card.data === undefined) {
      return cardRefused(`card ${cardId} not found in board ${boardId}`)
    }
    const updated = await this.deps.store.updateCard(roomId, boardId, cardId, { ownerId })
    if (!updated.ok || updated.data === null || updated.data === undefined) {
      return cardRefused(`could not set owner on card ${cardId}: ${updated.error ?? 'unknown'}`)
    }
    return { ok: true, message: `card ${cardId} owner set to ${ownerId}`, card: updated.data }
  }

  async deleteCard(roomId: string, boardId: string, cardId: string): Promise<CardOutcome> {
    if (!this.enabled) return cardRefused('board is disabled by config')
    if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return cardRefused('invalid id(s)')
    const card = await this.deps.store.getCard(roomId, boardId, cardId)
    if (!card.ok || card.data === null || card.data === undefined) {
      return cardRefused(`card ${cardId} not found in board ${boardId}`)
    }
    const result = await this.deps.store.deleteCard(roomId, boardId, cardId)
    if (!result.ok) return cardRefused(`could not delete card ${cardId}: ${result.error ?? 'unknown'}`)
    if (result.data !== true) return cardRefused(`card ${cardId} not found`)
    return { ok: true, message: `card ${cardId} deleted` }
  }

  // --------------------------------------------------------- comment CRUD ----

  async addComment(input: {
    roomId: string
    boardId: string
    cardId: string
    text: string
    authorSessionId?: string
    authorLabel?: string
  }): Promise<CommentOutcome> {
    if (!this.enabled) return commentRefused('board is disabled by config')
    const roomId = stringArg(input.roomId)
    const boardId = stringArg(input.boardId)
    const cardId = stringArg(input.cardId)
    const text = input.text?.trim() ?? ''
    if (roomId === '' || !isSafeKey(roomId)) return commentRefused('roomId is required')
    if (boardId === '' || !isSafeKey(boardId)) return commentRefused('boardId is required')
    if (cardId === '' || !isSafeKey(cardId)) return commentRefused('cardId is required')
    if (text === '') return commentRefused('a comment needs non-empty text')
    const result = await this.deps.store.addComment({
      roomId,
      boardId,
      cardId,
      text,
      ...(input.authorSessionId !== undefined ? { authorSessionId: input.authorSessionId } : {}),
      ...(input.authorLabel !== undefined ? { authorLabel: input.authorLabel } : {}),
    })
    if (!result.ok || result.data === null || result.data === undefined) {
      return commentRefused(`could not add comment: ${result.error ?? 'unknown'}`)
    }
    return { ok: true, message: `comment ${result.data.id} added`, comment: result.data }
  }

  async listComments(roomId: string, boardId: string, cardId: string, options?: { limit?: number }): Promise<{
    ok: boolean
    comments?: BoardComment[]
    message: string
  }> {
    if (!this.enabled) return { ok: false, message: 'board is disabled by config' }
    if (!isSafeKey(roomId) || !isSafeKey(boardId) || !isSafeKey(cardId)) return { ok: false, message: 'invalid id(s)' }
    const card = await this.deps.store.getCard(roomId, boardId, cardId)
    if (!card.ok || card.data === null || card.data === undefined) {
      return { ok: false, message: `card ${cardId} not found in board ${boardId}` }
    }
    const result = await this.deps.store.listComments(roomId, boardId, cardId, options)
    if (!result.ok) return { ok: false, message: `could not read comments: ${result.error ?? 'unknown'}` }
    return { ok: true, comments: result.data, message: `${result.data.length} comment(s) on card ${cardId}` }
  }
}

let instance: BoardService | undefined
let lastDeps: ModuleDeps | undefined

export function boardService(deps: ModuleDeps): BoardService {
  if (instance !== undefined && lastDeps === deps) return instance
  instance = new BoardService(deps)
  lastDeps = deps
  return instance
}

export function resetBoardService(): void {
  instance = undefined
  lastDeps = undefined
}
