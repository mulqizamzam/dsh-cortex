/**
 * Mock transport for tests and for a UI that must be reviewable without a host
 * (`createMockTransport()` answers the same `/dsh-cortex-read` +
 * `/dsh-cortex-write` dispatch as `src/host/index.ts`).
 *
 * One fixture per endpoint, keyed by the frozen names in
 * `.dev/RPC-ENDPOINTS.md`, including the wave-2 `prompts.*` pair so the panel's
 * prompts tab can be exercised before M4 lands. `calls` records every
 * (channel, endpoint, payload) so a test can assert the EXACT write payload —
 * a UI that approves the wrong row is a data-integrity bug, not a style bug.
 *
 * Behaviour that mirrors the host on purpose:
 *   - unknown endpoint → `{ok:false,error:{code:'unknown-endpoint'}}`;
 *   - `pending.approve` is routed BY KIND (only `memory` has an approver in
 *     wave-1; anything else answers `unsupported-kind`);
 *   - a queued `failure` or `errorEndpoint` yields an envelope the panel must
 *     render as an inline error, never throw.
 */
import { CORTEX_READ_CHANNEL, CORTEX_WRITE_CHANNEL } from './api.ts'
import type { RpcCall } from './api.ts'

/** A raw reply, envelope included — the transport's own shape. */
export type MockReply = { ok: true; value: unknown } | { ok: false; error: { code?: string; message?: string } }

export interface MockCall {
  channel: string
  endpoint: string
  payload: Record<string, unknown>
}

const PENDING_ID = 'p-1001'
const ROOM_ID = 'standups'
const BOARD_ID = 'b-sprint-1'

/** Endpoint name → reply. Later fixtures may be functions of the payload. */
export type MockHandler = (payload: Record<string, unknown>) => MockReply

const fixtures: Record<string, MockHandler> = {
  ping: () => ({
    ok: true,
    value: {
      plugin: 'dsh-cortex',
      version: '0.1.0',
      stateRoot: '/tmp/dsh-cortex-mock',
      injectEnabled: true,
      echoKeys: [],
    },
  }),

  'memory.list': () => ({
    ok: true,
    value: {
      entries: [
        {
          id: 'a1b2c3d4e5f60718',
          track: 'user',
          content: 'Prefers terse answers with the action first.',
          importance: 4,
          tags: ['style'],
          createdAt: '2026-09-10T08:00:00.000Z',
          updatedAt: '2026-09-10T08:00:00.000Z',
          origin: 'user',
        },
        {
          id: '0f1e2d3c4b5a6978',
          track: 'project',
          content: 'Build runs through tsdown; lib/ is a disposable artifact.',
          importance: 3,
          tags: ['build'],
          branches: ['main'],
          pid: 'proj-1',
          createdAt: '2026-09-11T09:00:00.000Z',
          updatedAt: '2026-09-12T09:00:00.000Z',
          origin: 'ai-confirmed',
        },
      ],
      truncated: false,
      branch: 'main',
      pid: 'proj-1',
    },
  }),

  'memory.search': payload => ({
    ok: true,
    value: {
      hits: [
        {
          id: 'a1b2c3d4e5f60718',
          track: 'user',
          snippet: `…${String(payload.query ?? '')} answers with the action first…`,
          score: 4,
          branches: [],
          archived: false,
        },
      ],
      candidates: 1,
      shown: 1,
      omitted: 0,
      listingTruncated: false,
    },
  }),

  'pending.list': () => ({
    ok: true,
    value: {
      items: [
        {
          id: PENDING_ID,
          kind: 'memory',
          proposal: { track: 'project', content: 'Room posts are capped at 2k chars.', tags: ['rooms'] },
          reason: 'stated twice in one session',
          fromSessionId: 'sess-77',
          origin: 'ai',
          createdAt: '2026-09-14T10:00:00.000Z',
          status: 'pending',
        },
        {
          id: 'p-1002',
          kind: 'todo',
          proposal: { track: 'work', text: 'Rotate the delegate runner allow-list' },
          reason: 'asked for, not confirmed',
          createdAt: '2026-09-14T11:00:00.000Z',
          status: 'pending',
        },
      ],
      truncated: false,
    },
  }),

  'todo.list': () => ({
    ok: true,
    value: {
      items: [
        {
          id: 't-1',
          track: 'work',
          text: 'Ship the cortex client panel',
          done: false,
          important: true,
          urgent: false,
          due: '2026-09-20',
          overdue: false,
          createdAt: '2026-09-12T08:00:00.000Z',
          completedAt: null,
        },
        {
          id: 't-2',
          track: 'daily',
          text: 'Review yesterday log',
          done: true,
          important: false,
          urgent: false,
          due: null,
          overdue: false,
          createdAt: '2026-09-11T08:00:00.000Z',
          completedAt: '2026-09-12T18:00:00.000Z',
        },
      ],
      lines: ['- [ ] (work · i) Ship the cortex client panel'],
      truncated: false,
    },
  }),

  'logs.read': payload => ({
    ok: true,
    value: {
      scope: payload.scope === 'daily' ? 'daily' : 'project',
      days: [
        { date: '2026-09-14', text: '## 2026-09-14\n- wired rooms rpc', lines: 2 },
        { date: '2026-09-13', text: '## 2026-09-13\n- memory scope cache', lines: 1 },
      ],
    },
  }),

  'rooms.list': () => ({
    ok: true,
    value: {
      rooms: [
        {
          id: ROOM_ID,
          title: 'Standups',
          lastSeq: 12,
          createdAt: '2026-09-09T07:00:00.000Z',
          createdBy: 'ui',
          members: [
            { sessionId: 'sess-77', label: 'worker-1', status: 'running', lastSeen: '2026-09-14T12:00:00.000Z' },
            { sessionId: 'sess-78', label: 'reviewer', status: 'gone', lastSeen: '2026-09-13T12:00:00.000Z' },
            { sessionId: null, label: 'waiting-room', status: 'unknown', lastSeen: null },
          ],
        },
      ],
    },
  }),

  'rooms.read': payload => ({
    ok: true,
    value: {
      messages: [
        { seq: 11, from: 'worker-1', fromKind: 'session', text: 'panel mounts, wiring rpc now', at: '2026-09-14T12:01:00.000Z', images: [] },
        {
          seq: 12,
          from: 'reviewer',
          fromKind: 'session',
          // Deliberately hostile: the panel must show this as TEXT, not markup.
          text: '<img src=x onerror="alert(1)"> check <script>escaping</script> https://example.com/x',
          at: '2026-09-14T12:02:00.000Z',
          images: [],
        },
      ],
      ...(payload.sinceSeq === undefined ? {} : { sinceSeq: payload.sinceSeq }),
      nextSeq: 12,
      hasMore: true,
      total: 12,
    },
  }),

  'rooms.status': () => ({
    ok: true,
    value: {
      members: [
        { sessionId: 'sess-77', label: 'worker-1', state: 'running', model: 'dsk-4', cwd: '/repo/app', unread: 2 },
        { sessionId: 'sess-78', label: 'reviewer', state: 'gone', model: null, cwd: null, unread: 0 },
      ],
      lastSeq: 12,
      summary: '2 session member(s), 0 label-only; last seq 12',
    },
  }),

  'sessions.status': () => ({
    ok: true,
    value: {
      canSpawn: true,
      spawnedByThisPlugin: ['sess-77'],
      live: [{ sessionId: 'sess-77', status: 'running', cwd: '/repo/app' }],
    },
  }),

  'jobs.list': () => ({
    ok: true,
    // The live host answers this endpoint with a bare array (see
    // modules/delegate/service.ts); the adapter normalises both shapes.
    value: [
      {
        id: 'j-1',
        runner: 'echo',
        status: 'running',
        startedAt: '2026-09-14T12:00:00.000Z',
        finishedAt: null,
        exitCode: null,
        summaryChars: 0,
      },
      {
        id: 'j-2',
        runner: 'echo',
        status: 'failed',
        startedAt: '2026-09-14T11:00:00.000Z',
        finishedAt: '2026-09-14T11:05:00.000Z',
        exitCode: 1,
        summaryChars: 24,
      },
    ],
  }),

  'jobs.get': payload => ({
    ok: true,
    value: {
      id: String(payload.jobId ?? 'j-1'),
      runner: 'echo',
      status: 'failed',
      startedAt: '2026-09-14T11:00:00.000Z',
      finishedAt: '2026-09-14T11:05:00.000Z',
      exitCode: 1,
      task: 'summarise the diff',
      error: 'runner exited 1',
    },
  }),

  'jobs.logs': () => ({
    ok: true,
    value: { stdout: 'line one\nline two\n', stderr: 'warn: <b>not html</b>\n', truncated: false },
  }),

  'jobs.result': () => ({ ok: true, value: { text: 'result body' } }),

  // wave-2 (M4): may not be mounted yet; the panel renders the refusal.
  'prompts.list': () => ({
    ok: true,
    value: {
      prompts: [
        { id: 'pr-1', title: 'Review checklist', body: 'Look at error paths first.', category: 'review', enabled: true, bodyChars: 26 },
      ],
      enabled: true,
    },
  }),
  'prompts.get': payload => ({
    ok: true,
    value: { id: String(payload.id ?? 'pr-1'), title: 'Review checklist', body: 'Look at error paths first.', enabled: true },
  }),

  // ---- writes ----
  'pending.approve': payload =>
    payload.id === PENDING_ID
      ? { ok: true, value: { id: String(payload.id), kind: 'memory', status: 'approved', entryId: 'a1b2c3d4e5f60718' } }
      : { ok: true, value: { id: String(payload.id ?? ''), kind: 'todo', status: 'approved', message: 'todo approved' } },

  'pending.reject': payload => ({ ok: true, value: { id: String(payload.id ?? ''), status: 'rejected' } }),

  'memory.archive': payload => ({ ok: true, value: { id: String(payload.id ?? ''), archived: true } }),
  'memory.restore': payload => ({ ok: true, value: { id: String(payload.id ?? ''), restored: true } }),
  'memory.delete': payload =>
    typeof payload.confirm === 'string' && payload.confirm.length > 0
      ? { ok: true, value: { id: String(payload.id ?? ''), deleted: true } }
      : { ok: true, value: { id: String(payload.id ?? ''), deleted: false, token: 'cf_mock_token' } },
  'memory.update': payload => ({ ok: true, value: { id: String(payload.id ?? ''), updated: true } }),

  'todo.add': payload => ({
    ok: true,
    value: {
      id: 't-new',
      track: payload.track,
      text: payload.text,
      done: false,
      createdAt: '2026-09-15T12:00:00.000Z',
    },
  }),
  'todo.complete': payload => ({ ok: true, value: { id: String(payload.id ?? ''), done: true } }),
  'todo.remove': payload => ({ ok: true, value: { id: String(payload.id ?? ''), removed: true } }),

  // --- board ---------------------------------------------------------------
  // One board with a card in every column and a comment on the first, so the
  // 3-column render and the comment path are both reachable from a test.
  'boards.list': () => ({
    ok: true,
    value: {
      boards: [
        { id: BOARD_ID, title: 'Sprint Board', cardCount: 3, createdAt: '2026-09-15T09:00:00.000Z' },
      ],
    },
  }),
  'boards.get': payload => ({
    ok: true,
    value: {
      board: { id: String(payload.boardId ?? BOARD_ID), roomId: String(payload.roomId ?? ROOM_ID), title: 'Sprint Board', createdAt: '2026-09-15T09:00:00.000Z' },
      cards: [
        { id: 'c-1', boardId: BOARD_ID, title: 'Wire the slots seam', status: 'backlog', description: 'panel must reach the host', dependencies: [], createdAt: '2026-09-15T09:01:00.000Z', updatedAt: '2026-09-15T09:01:00.000Z' },
        { id: 'c-2', boardId: BOARD_ID, title: 'Ship the board tools', status: 'in-progress', ownerId: 'sess-77', dependencies: ['c-1'], createdAt: '2026-09-15T09:02:00.000Z', updatedAt: '2026-09-15T09:02:00.000Z' },
        { id: 'c-3', boardId: BOARD_ID, title: 'Verify in the GUI', status: 'done', dependencies: ['c-2'], createdAt: '2026-09-15T09:03:00.000Z', updatedAt: '2026-09-15T09:04:00.000Z' },
      ],
      comments:
        payload.includeComments === true
          ? [{ id: 'k-1', cardId: 'c-2', authorSessionId: 'sess-77', text: 'blocked on the host seam', createdAt: '2026-09-15T09:05:00.000Z' }]
          : [],
    },
  }),
  'boards.create': payload => ({ ok: true, value: { id: BOARD_ID, roomId: String(payload.roomId ?? ROOM_ID), title: String(payload.title ?? 'new board'), cardCount: 0 } }),
  'boards.addCard': payload => ({ ok: true, value: { id: 'c-new', boardId: String(payload.boardId ?? BOARD_ID), title: String(payload.title ?? ''), status: payload.status ?? 'backlog', dependencies: [] } }),
  'boards.moveCard': payload => ({ ok: true, value: { id: String(payload.cardId ?? ''), boardId: String(payload.boardId ?? BOARD_ID), status: payload.status ?? 'backlog' } }),
  'boards.comment': payload => ({ ok: true, value: { id: 'k-new', cardId: String(payload.cardId ?? ''), authorSessionId: 'sess-77', text: String(payload.text ?? ''), createdAt: '2026-09-15T09:06:00.000Z' } }),
  'boards.delete': payload => ({ ok: true, value: { id: String(payload.boardId ?? BOARD_ID), deleted: true } }),

  'rooms.create': payload => ({
    ok: true,
    value: { room: { id: 'new-room', title: String(payload.title ?? ''), lastSeq: 0, members: [] }, message: 'room created' },
  }),
  'rooms.post': payload => ({ ok: true, value: { seq: 13, images: [], refused: [], counts: { sent: 1 }, message: 'posted' } }),
  'rooms.join': payload => ({ ok: true, value: { message: `joined ${String(payload.roomId ?? '')}` } }),
  'rooms.leave': payload => ({ ok: true, value: { message: `left ${String(payload.roomId ?? '')}` } }),
  'rooms.spawn': payload => ({ ok: true, value: { sessionId: 'sess-new', message: `spawned ${String(payload.label ?? '')}` } }),
  'rooms.send': payload => ({ ok: true, value: { seq: 14, message: `sent to ${String(payload.sessionId ?? '')}` } }),

  'jobs.cancel': payload => ({ ok: true, value: { message: `cancelled ${String(payload.jobId ?? '')}` } }),
  'jobs.retry': payload => ({ ok: true, value: { newJobId: `retry-of-${String(payload.jobId ?? '')}` } }),

  'prompts.save': payload => ({ ok: true, value: { id: String(payload.id ?? 'pr-new'), saved: true } }),
  'prompts.toggle': payload => ({ ok: true, value: { id: String(payload.id ?? ''), enabled: payload.enabled === true } }),
  'prompts.delete': payload => ({ ok: true, value: { id: String(payload.id ?? ''), deleted: true } }),
}

/** Endpoints a "kind has no approver yet" answer is the honest one for. */
function approveByKind(payload: Record<string, unknown>): MockReply {
  const handler = fixtures['pending.approve']
  return handler(payload)
}

export interface MockTransportOptions {
  /** Extra or overriding handlers, keyed by endpoint. */
  handlers?: Record<string, MockHandler>
  /** Endpoints that answer `{ok:false}` with this message (unknown-endpoint). */
  missing?: string[]
  /** Endpoints that make the transport REJECT (a broken socket, not a refusal). */
  throwing?: string[]
  /** Reply for `sessions.status`; use `{canSpawn:false, reason:'…'}` for the gate test. */
  sessionsStatus?: unknown
  /** `pending.approve` kind routing on/off (default on, like the host). */
  approveByKind?: boolean
}

/** The transport plus its call log. */
export interface MockTransport {
  call: RpcCall
  calls: MockCall[]
  /** Endpoints seen, in call order, as `channel endpoint`. */
  log(): string[]
  /** Last recorded call for an endpoint, or undefined. */
  last(endpoint: string): MockCall | undefined
  reset(): void
}

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
}

/** A canned failure envelope. */
export function failReply(code: string, message: string): MockReply {
  return { ok: false, error: { code, message } }
}

/**
 * Build the mock. `call` has the same arity as the real
 * `connection.rpc.call`, so `createCortexApi(mock.call)` is the whole wiring.
 */
export function createMockTransport(options: MockTransportOptions = {}): MockTransport {
  const handlers: Record<string, MockHandler> = { ...fixtures, ...(options.handlers ?? {}) }
  const missing = new Set(options.missing ?? [])
  const throwing = new Set(options.throwing ?? [])
  const calls: MockCall[] = []

  const call: RpcCall = async (channel, endpoint, payload) => {
    const body = payloadOf(payload)
    calls.push({ channel, endpoint, payload: body })
    if (throwing.has(endpoint)) throw new Error(`mock transport blew up on ${endpoint}`)
    if (missing.has(endpoint)) {
      const side = channel === CORTEX_WRITE_CHANNEL ? 'write' : 'read'
      return failReply('unknown-endpoint', `unknown cortex ${side} endpoint: ${endpoint}`)
    }
    if (endpoint === 'sessions.status' && options.sessionsStatus !== undefined) {
      return { ok: true, value: options.sessionsStatus }
    }
    const handler = handlers[endpoint]
    // `approveByKind` only applies when the caller did not override the
    // endpoint itself — an explicit fixture always wins over the convenience.
    if (endpoint === 'pending.approve' && options.approveByKind === true && options.handlers?.['pending.approve'] === undefined) {
      return approveByKind(body)
    }
    if (handler === undefined) {
      const side = channel === CORTEX_WRITE_CHANNEL ? 'write' : 'read'
      return failReply('unknown-endpoint', `unknown cortex ${side} endpoint: ${endpoint}`)
    }
    // The real dispatcher answers `ping` with the echo keys it was given.
    if (endpoint === 'ping') {
      const base = handlers.ping(body)
      return base.ok === true
        ? { ok: true, value: { ...(base.value as Record<string, unknown>), echoKeys: Object.keys(body) } }
        : base
    }
    return handler(body)
  }

  return {
    call,
    calls,
    log: () => calls.map(item => `${item.channel} ${item.endpoint}`),
    last: endpoint => [...calls].reverse().find(item => item.endpoint === endpoint),
    reset: () => {
      calls.length = 0
    },
  }
}

/** A transport that only ever fails: the honest-empty-state test fixture. */
export function createFailingTransport(message = 'host not reachable'): MockTransport {
  return createMockTransport({
    throwing: Object.keys(fixtures),
    handlers: Object.fromEntries(
      Object.keys(fixtures).map(endpoint => [
        endpoint,
        (): MockReply => ({ ok: false, error: { code: 'transport', message } }),
      ]),
    ),
  })
}

export { BOARD_ID, PENDING_ID, ROOM_ID }
