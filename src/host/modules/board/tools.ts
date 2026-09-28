/**
 * Board tools: the seven `cortex_board_*` AI tools.
 *
 * Every description is static and brace-pair-free (host issue-class #53).
 * Every result passes `neutralizeDeep` at this render edge (P9).
 * Failures are sentences containing the next move, never a stack.
 */
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import type { BoardService } from './service.ts'
import type { BoardCard, BoardStatus } from '../../types.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: import('../../dsh.ts').HostAgent }

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

const ROOM_ID = { type: 'string', description: 'Room id, as returned by cortex_room_create or cortex_room_list.' } as const
const BOARD_ID = { type: 'string', description: 'Board id, as returned by cortex_board_create or cortex_board_list.' } as const
const CARD_ID = { type: 'string', description: 'Card id, as returned by cortex_board_add or a board.get result.' } as const
const STATUS_ENUM = { type: 'string', enum: ['backlog', 'in-progress', 'done'], description: 'Column to move the card into.' } as const

export function boardTools(svc: BoardService): ToolDefinition[] {
  const create = defineTool({
    name: 'cortex_board_create',
    description:
      'Create a task board in a room for inter-agent coordination. '
      + 'The board has three columns: backlog, in-progress, and done. '
      + 'All agents in the room can read and write to it. '
      + 'Requires a valid roomId from cortex_room_create or cortex_room_list.',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        title: { type: 'string', description: 'Short title for this board (e.g. "Sprint 1 tasks").' },
      },
      required: ['roomId', 'title'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const result = await svc.create({
        title: String(a.title ?? ''),
        roomId: String(a.roomId ?? ''),
        ...(execution.agent?.id ? { createdBy: execution.agent.id } : {}),
      })
      return neutralizeDeep({
        status: result.ok ? 'created' : 'refused',
        message: result.message,
        boardId: result.boardId ?? null,
        roomId: result.roomId ?? null,
      })
    },
  } as never)

  const list = defineTool({
    name: 'cortex_board_list',
    description:
      'List all task boards in a room, with card count and creation time. '
      + 'Read-only. Use cortex_board_create to make a new one.',
    parameters: {
      type: 'object',
      properties: { roomId: ROOM_ID },
      required: ['roomId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Args
      const result = await svc.list(String(a.roomId ?? ''))
      return neutralizeDeep({
        status: result.ok ? 'ok' : 'refused',
        message: result.message,
        boards: result.boards,
      })
    },
  } as never)

  const get = defineTool({
    name: 'cortex_board_get',
    description:
      'Read a board: all cards with their current status, owner, and dependencies. '
      + 'Pass includeComments=true to also get the comment threads for every card. '
      + 'This is the primary way agents discover each other\'s work in a room.',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        boardId: BOARD_ID,
        includeComments: { type: 'boolean', description: 'Include comment threads for each card (default false). ' },
        commentLimit: { type: 'integer', description: 'Max comments per card when includeComments=true (default 50). ' },
      },
      required: ['roomId', 'boardId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Args
      const result = await svc.get(String(a.roomId ?? ''), String(a.boardId ?? ''), {
        includeComments: a.includeComments === true,
        ...(typeof a.commentLimit === 'number' ? { commentLimit: Math.max(1, Math.min(200, Math.floor(a.commentLimit))) } : {}),
      })
      const cards: Array<Record<string, unknown>> = (result.board ?? []).map(card => ({
        id: card.id,
        title: card.title,
        status: card.status,
        owner: card.ownerId ?? null,
        dependencies: card.dependencies,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
        ...(card.description !== undefined ? { description: card.description } : {}),
      }))
      return neutralizeDeep({
        status: result.ok ? 'ok' : 'refused',
        message: result.message,
        cards: cards.length > 0 ? cards : [],
        comments: result.comments?.map(c => ({
          id: c.id,
          cardId: c.cardId,
          author: c.authorLabel ?? c.authorSessionId ?? null,
          text: c.text,
          at: c.createdAt,
        })) ?? [],
      })
    },
  } as never)

  const add = defineTool({
    name: 'cortex_board_add',
    description:
      'Add a card to a board. A card is a unit of work with an owner session, optional dependencies, '
      + 'and an initial status (defaults to backlog). All members of the room can see new cards '
      + 'via cortex_board_get.',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        boardId: BOARD_ID,
        title: { type: 'string', description: 'One-line description of the work.' },
        description: { type: 'string', description: 'Optional longer description or acceptance criteria.' },
        status: STATUS_ENUM,
        ownerId: { type: 'string', description: 'Session id of the agent who owns this card (or the UI session). ' },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of other cards that must be done before this one. Max 20.',
        },
      },
      required: ['roomId', 'boardId', 'title'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const result = await svc.addCard({
        roomId: String(a.roomId ?? ''),
        boardId: String(a.boardId ?? ''),
        title: String(a.title ?? ''),
        ...(typeof a.description === 'string' ? { description: a.description } : {}),
        ...(typeof a.status === 'string' && ['backlog', 'in-progress', 'done'].includes(a.status) ? { status: a.status as BoardStatus } : {}),
        ...(typeof a.ownerId === 'string' ? { ownerId: a.ownerId } : {}),
        ...(Array.isArray(a.dependencies) ? { dependencies: a.dependencies.filter(d => typeof d === 'string') } : {}),
      })
      return neutralizeDeep({
        status: result.ok ? 'added' : 'refused',
        message: result.message,
        card: result.card ?? null,
      })
    },
  } as never)

  const move = defineTool({
    name: 'cortex_board_move',
    description:
      'Move a card to a different column: backlog, in-progress, or done. '
      + 'Agents move their own cards as work progresses; done is the terminal state '
      + 'that unlocks any cards that depend on this one.',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        boardId: BOARD_ID,
        cardId: CARD_ID,
        status: STATUS_ENUM,
      },
      required: ['roomId', 'boardId', 'cardId', 'status'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Args
      const status = a.status
      if (status !== 'backlog' && status !== 'in-progress' && status !== 'done') {
        return neutralizeDeep({ status: 'refused', message: 'status must be backlog, in-progress, or done.' })
      }
      const result = await svc.moveCard(String(a.roomId ?? ''), String(a.boardId ?? ''), String(a.cardId ?? ''), status as BoardStatus)
      return neutralizeDeep({
        status: result.ok ? 'moved' : 'refused',
        message: result.message,
        cardId: result.card?.id ?? null,
        cardStatus: result.card?.status ?? null,
      })
    },
  } as never)

  const comment = defineTool({
    name: 'cortex_board_comment',
    description:
      'Add a comment to a card in the room\'s task board. Comments are how agents '
      + 'coordinate: "I\'ll take this", "blocked waiting on X", "done, here\'s the result". '
      + 'All members of the room can read the thread via cortex_board_get {includeComments:true}.',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        boardId: BOARD_ID,
        cardId: CARD_ID,
        text: { type: 'string', description: 'The comment body.' },
      },
      required: ['roomId', 'boardId', 'cardId', 'text'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const result = await svc.addComment({
        roomId: String(a.roomId ?? ''),
        boardId: String(a.boardId ?? ''),
        cardId: String(a.cardId ?? ''),
        text: String(a.text ?? ''),
        ...(execution.agent?.id ? { authorSessionId: execution.agent.id, authorLabel: `session ${execution.agent.id.slice(0, 12)}` } : { authorLabel: 'ui' }),
      })
      return neutralizeDeep({
        status: result.ok ? 'added' : 'refused',
        message: result.message,
        comment: result.comment ?? null,
      })
    },
  } as never)

  const deleteBoard = defineTool({
    name: 'cortex_board_delete',
    description:
      'Delete a board and all its cards and comments. '
      + 'This is destructive: use it only when the work is truly abandoned, '
      + 'not to hide stale boards.',
    parameters: {
      type: 'object',
      properties: { roomId: ROOM_ID, boardId: BOARD_ID },
      required: ['roomId', 'boardId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Args
      const result = await svc.delete(String(a.roomId ?? ''), String(a.boardId ?? ''))
      return neutralizeDeep({
        status: result.ok ? 'deleted' : 'refused',
        message: result.message,
        boardId: result.boardId ?? null,
      })
    },
  } as never)

  return [create, list, get, add, move, comment, deleteBoard]
}
