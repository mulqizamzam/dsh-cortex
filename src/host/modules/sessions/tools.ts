/**
 * The two session tools (DESIGN §4). Same render contract as the room tools:
 * static brace-free descriptions, `neutralizeDeep` on every result, failures as
 * sentences that name the next move.
 *
 * `cortex_session_spawn` is the honest one: it says whether the host had a
 * factory at all, whether the cwd guard accepted the path, and what the task
 * delivery did — including "nothing woke, the target has no live agent".
 */
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { HostAgent, ToolDefinition } from '../../dsh.ts'
import type { RoomService } from '../rooms/service.ts'
import { callerSessionId } from '../rooms/service.ts'
import { IMAGE_MAX_PER_POST } from '../rooms/images.ts'
import { sendToSession, spawnFactory, spawnSession, spawnedSessionIds } from './spawn.ts'
import type { SpawnDeps } from './spawn.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: HostAgent }

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Sessions this module did not create but the host reports as live. */
export function otherLiveSessions(rooms: RoomService, exclude: readonly string[]): Array<Record<string, unknown>> {
  return rooms.liveAgents()
    .filter(agent => !exclude.includes(agent.id))
    .map(agent => ({
      sessionId: agent.id,
      status: agent.status,
      model: agent.options?.model ?? null,
      cwd: agent.session?.header?.cwd ?? null,
    }))
}

export function sessionTools(svc: SpawnDeps): ToolDefinition[] {
  const spawn = defineTool({
    name: 'cortex_session_spawn',
    description:
      'Create a NEW dsh-cortex session through the host agent factory and enroll it in a room, then hand it a '
      + 'task. Requires the host to expose an agent factory: if it does not, this returns a refusal and the '
      + 'room still works by joining sessions that already exist (cortex_room_join). The new member inherits '
      + 'the caller\'s provider/model and cwd unless you pass them explicitly. A requested cwd is accepted '
      + 'only when it is the caller\'s cwd (or below it) or inside the plugin state root - arbitrary paths are '
      + 'refused, because the host keys session storage off it. The task is delivered to the new session '
      + 'directly; the room gets a labelled system line about the join.',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Room to enroll the new session in.' },
        label: { type: 'string', description: 'Short name for the new member in the transcript.' },
        prompt: { type: 'string', description: 'The task text handed to the new session.' },
        cwd: { type: 'string', description: 'Optional absolute working directory; subject to the guard above.' },
        model: { type: 'string', description: 'Optional model id; defaults to the caller\'s model.' },
        provider: { type: 'string', description: 'Optional provider route; defaults to the caller\'s provider.' },
      },
      required: ['roomId', 'label', 'prompt'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = args as Args
      const roomId = stringArg(a.roomId)
      const sessionId = callerSessionId(execution.agent)
      const result = await spawnSession({
        roomId,
        label: stringArg(a.label),
        prompt: typeof a.prompt === 'string' ? a.prompt : '',
        ...(a.cwd === undefined ? {} : { cwd: a.cwd }),
        ...(a.model === undefined ? {} : { model: a.model }),
        ...(a.provider === undefined ? {} : { provider: a.provider }),
        ...(sessionId === undefined ? {} : { fromSessionId: sessionId }),
      }, svc)
      const rooms = svc.rooms
      return neutralizeDeep({
        status: result.ok ? 'spawned' : 'refused',
        message: result.message,
        sessionId: result.sessionId ?? null,
        roomId,
        hostCanSpawn: spawnFactory(svc.deps.ctx.agents) !== undefined,
        spawnedByThisPlugin: spawnedSessionIds(),
        liveSessions: otherLiveSessions(rooms, spawnedSessionIds()),
        counts: result.counts === undefined ? null : { wake: result.counts.wake, nextStep: result.counts.steer, offline: result.counts.offline, failed: result.counts.failed, deferred: result.counts.deferred },
        delivery: (result.results ?? []).map(item => ({ sessionId: item.sessionId, disposition: item.disposition, detail: item.detail })),
        ...(result.hint === undefined ? {} : { hint: result.hint }),
      })
    },
  } as never)

  const send = defineTool({
    name: 'cortex_session_send',
    description:
      'Send a message to ONE session through a room it belongs to (membership is what authorizes a send, and '
      + 'the room keeps the exchange auditable). Delivery follows the live state of the target and the result '
      + 'reports the counts honestly: an idle target is woken now, a running target receives it at its next '
      + 'step, and a session with no live agent here is left a message the plugin injects at its next turn. '
      + 'There is no auto-create: if the target is gone, spawn it or ask it to join.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session id (must be a room member).' },
        text: { type: 'string', description: 'The message body.' },
        roomId: { type: 'string', description: 'Optional room to post it in; defaults to the newest shared one.' },
        images: { type: 'array', items: { type: 'string' }, description: `Optional absolute paths inside the plugin state root, at most ${String(IMAGE_MAX_PER_POST)}.` },
      },
      required: ['sessionId', 'text'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = args as Args
      const sessionId = stringArg(a.sessionId)
      const textBody = typeof a.text === 'string' ? a.text : ''
      if (sessionId === '' || textBody.trim() === '') {
        return neutralizeDeep({ status: 'refused', message: 'sessionId and a non-empty text are required.' })
      }
      const from = callerSessionId(execution.agent)
      if (from === sessionId) {
        return neutralizeDeep({ status: 'refused', message: 'the calling session is the target: post to the room with cortex_room_post instead of mailing yourself.' })
      }
      const result = await sendToSession({
        sessionId,
        text: textBody,
        ...(stringArg(a.roomId) === '' ? {} : { roomId: stringArg(a.roomId) }),
        ...(from === undefined ? {} : { fromSessionId: from }),
        fromLabel: from === undefined ? undefined : `session ${clampText(from, 24)}`,
        ...(Array.isArray(a.images) ? { images: a.images.slice(0, IMAGE_MAX_PER_POST) } : {}),
      }, svc)
      return neutralizeDeep({
        status: result.ok ? 'sent' : 'refused',
        message: result.message,
        seq: result.seq ?? null,
        counts: result.counts === undefined ? null : { wake: result.counts.wake, nextStep: result.counts.steer, offline: result.counts.offline, failed: result.counts.failed, deferred: result.counts.deferred },
        delivery: (result.results ?? []).map(item => ({ sessionId: item.sessionId, disposition: item.disposition, detail: item.detail })),
      })
    },
  } as never)

  return [spawn, send]
}
