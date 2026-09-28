/**
 * The six room tools (DESIGN §4). The contract all six share:
 *
 *  - every description is static and brace-pair-free (host #53 / G14): no
 *    caller- or user-authored text is ever interpolated into a description or a
 *    parameter description;
 *  - every result passes `neutralizeDeep` at this render edge, so a room title,
 *    a member label or a message body authored somewhere else cannot smuggle a
 *    template pair into the transcript;
 *  - a failure is a sentence that contains the next move, never a stack (§4);
 *  - `rooms.enabled = false` refuses politely instead of half-working (P3).
 *
 * Identity comes from the CALLING agent (`execution.agent`): its session id is
 * the membership key and the author stamp on a message. A call with no agent
 * (headless context) can still read and list, but cannot post as a session.
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { HostAgent, ToolDefinition } from '../../dsh.ts'
import type { RoomService } from './service.ts'
import { callerSessionId } from './service.ts'
import { IMAGE_MAX_PER_POST } from './images.ts'
import { formatRoomMessages } from './mail.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: HostAgent }

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

const ROOM_ID = { type: 'string', description: 'Room id, as returned by cortex_room_create or cortex_room_list.' } as const
const DISABLED = 'Rooms are disabled by config (rooms.enabled = false); nothing was changed.'

/** The caller's own member label: short, stable, never an empty row. */
export function selfLabel(agent: HostAgent | undefined): string {
  const id = callerSessionId(agent) ?? 'unknown'
  return `session ${clampText(id, 24)}`
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function imageArg(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, IMAGE_MAX_PER_POST) : []
}

/** Room tools bound to one service (so two state roots never share a queue). */
/** Can this host create a session at all? Read-only feature-detect (HOST-API §6). */
export type SpawnProbe = () => boolean

export function roomTools(svc: RoomService, canSpawn: SpawnProbe = () => false): ToolDefinition[] {
  const gate = (): string | null => (svc.enabled ? null : DISABLED)

  const create = defineTool({
    name: 'cortex_room_create',
    description:
      'Create a collaboration room inside this plugin\'s state root and join it as the calling session. '
      + 'Returns the room id and the inbox directory where files to be posted must be placed. '
      + 'Rooms are how separate dsh-cortex sessions hand each other messages; nothing here leaves this machine.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human title for the room list.' },
      },
      required: ['title'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const refused = gate()
      if (refused !== null) return neutralizeDeep({ status: 'refused', message: refused })
      const title = stringArg((args as Args).title)
      if (title === '') return neutralizeDeep({ status: 'refused', message: 'a room needs a non-empty title.' })
      const agent = execution.agent
      const sessionId = callerSessionId(agent)
      const result = await svc.create({
        title,
        ...(sessionId === undefined ? {} : { createdBy: sessionId }),
        ...(sessionId === undefined
          ? {}
          : {
              joinAs: {
                label: selfLabel(agent),
                sessionId,
                ...(agent?.options?.model === undefined ? {} : { model: agent.options.model }),
                ...(agent?.session?.header?.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
              },
            }),
      })
      return neutralizeDeep({
        status: result.ok ? 'created' : 'refused',
        message: result.message,
        roomId: result.room?.id ?? null,
        callerSessionId: sessionId ?? null,
      })
    },
  } as never)

  const list = defineTool({
    name: 'cortex_room_list',
    description:
      'List every dsh-cortex room: id, title, members with their LIVE state (running, idle, gone) and the '
      + 'highest message sequence. Read-only. Use it to find a room to join before creating another one.',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async () => {
      const rooms = await svc.list()
      if (rooms.length === 0) {
        return neutralizeDeep({ status: 'ok', count: 0, rooms: [], message: 'no rooms yet - call cortex_room_create to make one.' })
      }
      return neutralizeDeep({
        status: 'ok',
        count: rooms.length,
        stateRoot: svc.root,
        rooms: rooms.map(room => ({ id: room.id, title: room.title, lastSeq: room.lastSeq, members: room.members.length })),
        message: rooms.map(room => svc.formatRoomLine(room)).join('\n'),
      })
    },
  } as never)

  const join = defineTool({
    name: 'cortex_room_join',
    description:
      'Join an existing room. Without sessionId it joins the CALLING session, which is what you want: from '
      + 'then on room mail for it is delivered at its next turn. With sessionId it enrolls another session, '
      + 'but only one the host currently reports as live. This is also the fallback when the host cannot '
      + 'spawn sessions: enroll sessions that already exist.',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        label: { type: 'string', description: 'How this member is shown in the transcript. Defaults to the session id.' },
        sessionId: { type: 'string', description: 'Optional other session to enroll. Must be a live session id.' },
      },
      required: ['roomId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const refused = gate()
      if (refused !== null) return neutralizeDeep({ status: 'refused', message: refused })
      const roomId = stringArg((args as Args).roomId)
      if (roomId === '') return neutralizeDeep({ status: 'refused', message: 'roomId is required.' })
      const given = stringArg((args as Args).sessionId)
      const own = callerSessionId(execution.agent)
      const sessionId = given === '' ? own : given
      if (sessionId === undefined) {
        return neutralizeDeep({ status: 'refused', message: 'there is no calling session and no sessionId was given, so there is nothing to enroll.' })
      }
      if (given !== '' && svc.live(given) === undefined) {
        return neutralizeDeep({ status: 'refused', message: `session ${given} is not live on this host, so it cannot be enrolled. That session can join itself with cortex_room_join.` })
      }
      const agent = sessionId === own ? execution.agent : svc.live(sessionId)
      const label = stringArg((args as Args).label)
      const result = await svc.join(roomId, {
        label: label === '' ? selfLabel(agent) : label,
        sessionId,
        ...(agent?.options?.model === undefined ? {} : { model: agent.options.model }),
        ...(agent?.session?.header?.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
      })
      return neutralizeDeep({ status: result.ok ? 'joined' : 'refused', message: result.message, roomId, sessionId })
    },
  } as never)

  const post = defineTool({
    name: 'cortex_room_post',
    description:
      'Post a message to a room as the calling session; it is stored with a monotonic sequence number. '
      + 'Every other member that is live is reached immediately - an idle one is woken, a running one gets it '
      + 'at its next step - and a member that is offline keeps it unread until the plugin injects it at that '
      + 'session\'s next turn. The result reports those counts per class, honestly. '
      + 'Images: pass absolute paths INSIDE this plugin state root (the room inbox directory). Any other path '
      + 'is refused and listed in the result. Receivers are told the stored absolute path and to open it with '
      + 'the read_image tool.',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        text: { type: 'string', description: 'The message body.' },
        images: { type: 'array', items: { type: 'string' }, description: `Absolute paths inside the plugin state root, at most ${String(IMAGE_MAX_PER_POST)}.` },
        notify: { type: 'boolean', description: 'Set false to store the message without reaching anyone.' },
      },
      required: ['roomId', 'text'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const refused = gate()
      if (refused !== null) return neutralizeDeep({ status: 'refused', message: refused })
      const roomId = stringArg((args as Args).roomId)
      const body = typeof (args as Args).text === 'string' ? String((args as Args).text) : ''
      const wanted = imageArg((args as Args).images)
      if (roomId === '') {
        return neutralizeDeep({ status: 'refused', message: 'roomId is required.' })
      }
      if (body.trim() === '' && wanted.length === 0) {
        return neutralizeDeep({ status: 'refused', message: 'a post needs a text body, an image path, or both.' })
      }
      const sessionId = callerSessionId(execution.agent)
      const result = await svc.post({
        roomId,
        text: body,
        images: wanted,
        ...(sessionId === undefined ? {} : { fromSessionId: sessionId, fromLabel: selfLabel(execution.agent) }),
        fromKind: 'session',
        notify: (args as Args).notify !== false,
      })
      const counts = result.counts
      return neutralizeDeep({
        status: result.ok ? 'posted' : 'refused',
        message: result.message,
        seq: result.seq ?? null,
        images: result.images ?? [],
        refusedImages: result.refused ?? [],
        counts: counts === undefined ? null : { wake: counts.wake, nextStep: counts.steer, offline: counts.offline, failed: counts.failed, self: counts.self },
        delivery: (result.results ?? []).map(item => ({ sessionId: item.sessionId, disposition: item.disposition, detail: item.detail })),
      })
    },
  } as never)

  const read = defineTool({
    name: 'cortex_room_read',
    description:
      'Read a room transcript oldest-first: sequence, author, timestamp, body and stored image paths. '
      + 'Read-only, capped output. sinceSeq skips what is already known; this reads the ROOM, not your own '
      + 'inbox watermark (that is delivered to you automatically).',
    parameters: {
      type: 'object',
      properties: {
        roomId: ROOM_ID,
        sinceSeq: { type: 'integer', description: 'Return only messages with a sequence above this.' },
        limit: { type: 'integer', description: 'Maximum messages. Default 25, hard cap 100.' },
      },
      required: ['roomId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const roomId = stringArg((args as Args).roomId)
      if (roomId === '') return neutralizeDeep({ status: 'refused', message: 'roomId is required.' })
      const rawSince = (args as Args).sinceSeq
      const rawLimit = (args as Args).limit
      const result = await svc.read(roomId, {
        ...(typeof rawSince === 'number' && Number.isFinite(rawSince) ? { sinceSeq: Math.floor(rawSince) } : {}),
        ...(typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? { limit: Math.floor(rawLimit) } : {}),
      })
      if (!result.ok) return neutralizeDeep({ status: 'refused', message: result.message, count: 0, messages: [] })
      return neutralizeDeep({
        status: 'ok',
        roomId,
        count: result.messages.length,
        text: formatRoomMessages(result.messages, svc.root, svc.caps().searchResultChars),
        messages: result.messages.map(message => ({
          seq: message.seq,
          from: neutralize(message.fromLabel ?? message.fromKind),
          fromSessionId: message.fromSessionId ?? null,
          at: message.at,
          kind: message.fromKind,
          images: message.images.map(rel => neutralize(rel)),
        })),
      })
    },
  } as never)

  const status = defineTool({
    name: 'cortex_room_status',
    description:
      'Who is in a room RIGHT NOW: each member session, its live state (running / idle / gone), model, cwd, '
      + 'unread count, and the room\'s highest sequence. Read-only. Call it before cortex_session_send so you '
      + 'know whether a target will be woken, steered, or left a message.',
    parameters: {
      type: 'object',
      properties: { roomId: ROOM_ID },
      required: ['roomId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const roomId = stringArg((args as Args).roomId)
      if (roomId === '') return neutralizeDeep({ status: 'refused', message: 'roomId is required.' })
      const result = await svc.status(roomId)
      if (!result.ok || result.rows === undefined) {
        return neutralizeDeep({ status: 'refused', message: result.message, members: [] })
      }
      const counts = { running: 0, idle: 0, gone: 0, unknown: 0 }
      for (const row of result.rows) {
        const state = String(row.state ?? 'unknown')
        counts[state === 'running' || state === 'idle' || state === 'gone' || state === 'unknown' ? state : 'unknown'] += 1
      }
      return neutralizeDeep({
        status: 'ok',
        roomId,
        hostCanSpawn: canSpawn() === true,
        title: result.room === undefined ? null : neutralize(result.room.title),
        lastSeq: result.room?.lastSeq ?? 0,
        message: result.message,
        counts,
        members: result.rows,
      })
    },
  } as never)

  const remove = defineTool({
    name: 'cortex_room_delete',
    description:
      'Permanently delete one room and everything in it: every message, every image, and every board with its cards and comments. Two steps by design: the first call names the room, reports what is in it and returns a single-use token; the second call must present that token. Without the token nothing is deleted, and the token is bound to the room it was issued for.',
    parameters: {
      type: 'object',
      properties: { roomId: ROOM_ID, confirm: { type: 'string', description: 'The token returned by the first call.' } },
      required: ['roomId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const raw = args as Args
      const result = await svc.delete({ roomId: stringArg(raw.roomId), confirm: raw.confirm })
      return neutralizeDeep({
        status: result.ok ? 'ok' : 'refused',
        message: result.message,
        roomId: stringArg(raw.roomId),
        token: result.token ?? null,
        deleted: result.deleted === true,
      })
    },
  } as never)

  return [create, list, join, post, read, status, remove]
}
