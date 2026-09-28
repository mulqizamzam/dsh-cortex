// @vitest-environment node
/**
 * The data adapter: every endpoint's exact payload, the envelope contract, and
 * the failure paths. If a number here disagrees with `.dev/RPC-ENDPOINTS.md`,
 * the endpoint doc is the one that wins and this file is the bug report.
 */
import { describe, expect, it } from 'vitest'
import {
  CORTEX_READ_CHANNEL,
  CORTEX_WRITE_CHANNEL,
  createCortexApi,
  memoryFilterArgs,
  nestedScope,
  normalizeJobs,
  normalizeRoomStatus,
  roomStateOf,
  scopeFields,
  unwrap,
} from '../../src/client/api.ts'
import { createMockTransport } from '../../src/client/mock-adapter.ts'

function transport() {
  const mock = createMockTransport()
  return { mock, api: createCortexApi(mock.call) }
}

describe('envelope unwrap', () => {
  it('reads the host shape both ways', () => {
    expect(unwrap({ ok: true, value: { a: 1 } })).toEqual({ ok: true, value: { a: 1 } })
    expect(unwrap({ ok: false, error: { code: 'refused', message: 'nope' } })).toEqual({
      ok: false,
      error: { code: 'refused', message: 'nope' },
    })
  })

  it('tolerates a string error and a bare value', () => {
    const result = unwrap<unknown>({ ok: false, error: 'socket closed' })
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toEqual({ code: 'rpc-error', message: 'socket closed' })
    }
    // A host that answers without an envelope must not read as a failure.
    expect(unwrap([{ id: 'j-1' }])).toEqual({ ok: true, value: [{ id: 'j-1' }] })
  })

  it('truncates a monster message instead of rendering a stack', () => {
    const result = unwrap({ ok: false, error: { message: 'x'.repeat(900) } })
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.error.message.length).toBeLessThanOrEqual(401)
  })
})

describe('scope passing', () => {
  it('memory takes flat identity fields', () => {
    expect(scopeFields({ branch: 'main', pid: 'p1', cwd: '/repo', sessionId: 's1' })).toEqual({
      branch: 'main',
      projectId: 'p1',
      cwd: '/repo',
      sessionId: 's1',
    })
  })

  it('drops empty and missing fields rather than sending noise', () => {
    expect(scopeFields({ branch: '', pid: undefined, cwd: '' })).toEqual({})
    expect(scopeFields()).toEqual({})
  })

  it('todo takes a NESTED scope (scopeFromPayload reads payload.scope)', () => {
    expect(nestedScope({ openOnly: true }, { pid: 'p1' })).toEqual({ openOnly: true, scope: { projectId: 'p1' } })
    expect(nestedScope({ openOnly: true }, {})).toEqual({ openOnly: true })
  })

  it('a filter chip maps to the handler arguments', () => {
    expect(memoryFilterArgs('all')).toEqual({})
    expect(memoryFilterArgs('archived')).toEqual({ archived: true })
    expect(memoryFilterArgs('project')).toEqual({ track: 'project' })
  })
})

describe('read payloads', () => {
  it('ping carries an empty object, and the echo proves it arrived', async () => {
    const { mock, api } = transport()
    const result = await api.ping()
    expect(mock.last('ping')?.channel).toBe(CORTEX_READ_CHANNEL)
    expect(result.ok).toBe(true)
    if (result.ok === false) throw new Error('ping failed')
    expect(result.value.stateRoot).toBe('/tmp/dsh-cortex-mock')
    expect(result.value.injectEnabled).toBe(true)
  })

  it('memory.list forwards the track filter and the scope', async () => {
    const { mock, api } = transport()
    await api.memoryList({ track: 'project', projectId: 'p1', branch: 'main' })
    expect(mock.last('memory.list')?.payload).toEqual({ track: 'project', projectId: 'p1', branch: 'main' })
  })

  it('memory.list without a filter sends {}', async () => {
    const { mock, api } = transport()
    await api.memoryList()
    expect(mock.last('memory.list')?.payload).toEqual({})
  })

  it('memory.search sends query + archive flag', async () => {
    const { mock, api } = transport()
    await api.memorySearch({ query: 'tsdown', includeArchive: true })
    expect(mock.last('memory.search')?.payload).toEqual({ query: 'tsdown', includeArchive: true })
  })

  it('logs.read sends the scope the handler requires', async () => {
    const { mock, api } = transport()
    const result = await api.logsRead({ scope: 'project', projectId: 'p1', lastDays: 3 })
    expect(mock.last('logs.read')?.payload).toEqual({ scope: 'project', projectId: 'p1', lastDays: 3 })
    expect(result.ok && result.value.days[0].date).toBe('2026-09-14')
  })

  it('rooms.read sends roomId, limit, and sinceSeq only when given', async () => {
    const { mock, api } = transport()
    await api.roomsRead('standups', undefined, 50)
    expect(mock.last('rooms.read')?.payload).toEqual({ roomId: 'standups', limit: 50 })
    await api.roomsRead('standups', 12)
    expect(mock.last('rooms.read')?.payload).toEqual({ roomId: 'standups', sinceSeq: 12 })
  })

  it('jobs.list normalises the host array into {jobs}', async () => {
    const { api } = transport()
    const result = await api.jobsList()
    expect(result.ok).toBe(true)
    if (result.ok === false) throw new Error('jobs.list failed')
    expect(result.value.jobs.map(job => job.id)).toEqual(['j-1', 'j-2'])
    expect(normalizeJobs([])).toEqual({ jobs: [] })
    expect(normalizeJobs({ jobs: [{ id: 'x' }] }).jobs).toHaveLength(1)
  })

  it('jobs.logs sends tailBytes only when asked', async () => {
    const { mock, api } = transport()
    await api.jobsLogs('j-1')
    expect(mock.last('jobs.logs')?.payload).toEqual({ jobId: 'j-1' })
    await api.jobsLogs('j-1', 4096)
    expect(mock.last('jobs.logs')?.payload).toEqual({ jobId: 'j-1', tailBytes: 4096 })
  })

  it('rooms.status rows arrive with a single `status` key', async () => {
    const { api } = transport()
    const result = await api.roomsStatus('standups')
    expect(result.ok).toBe(true)
    if (result.ok === false) throw new Error('rooms.status failed')
    expect(result.value.members.map(member => member.status)).toEqual(['running', 'gone'])
  })

  it('an unknown room state stays `unknown`, never a guess', () => {
    expect(roomStateOf('running')).toBe('running')
    expect(roomStateOf('weird')).toBe('unknown')
    expect(roomStateOf(undefined)).toBe('unknown')
    expect(normalizeRoomStatus({ members: [{ status: 'sideways' } as never], lastSeq: 0 }).members[0].status).toBe('unknown')
  })
})

describe('write payloads', () => {
  it('pending.approve sends exactly {id} on the write channel', async () => {
    const { mock, api } = transport()
    const result = await api.pendingApprove('p-1001')
    const call = mock.last('pending.approve')
    expect(call?.channel).toBe(CORTEX_WRITE_CHANNEL)
    expect(call?.payload).toEqual({ id: 'p-1001' })
    expect(result.ok).toBe(true)
  })

  it('pending.reject sends exactly {id}', async () => {
    const { mock, api } = transport()
    await api.pendingReject('p-1002')
    expect(mock.last('pending.reject')?.payload).toEqual({ id: 'p-1002' })
  })

  it('memory.delete performs the two-step confirm-token flow', async () => {
    const { mock, api } = transport()
    const result = await api.memoryDelete('a1b2c3d4e5f60718')
    const calls = mock.calls.filter(c => c.endpoint === 'memory.delete')
    expect(calls).toHaveLength(2)
    expect(calls[0].channel).toBe(CORTEX_WRITE_CHANNEL)
    expect(calls[0].payload).toEqual({ id: 'a1b2c3d4e5f60718' })
    expect(calls[1].channel).toBe(CORTEX_WRITE_CHANNEL)
    expect(calls[1].payload).toEqual({ id: 'a1b2c3d4e5f60718', confirm: 'cf_mock_token' })
    expect(result.ok).toBe(true)
    await api.memoryArchive('a1b2c3d4e5f60718')
    expect(mock.last('memory.archive')?.payload).toEqual({ id: 'a1b2c3d4e5f60718' })
    await api.memoryRestore('a1b2c3d4e5f60718')
    expect(mock.last('memory.restore')?.payload).toEqual({ id: 'a1b2c3d4e5f60718' })
  })

  it('todo.add keeps the nested scope and the human-path fields', async () => {
    const { mock, api } = transport()
    await api.todoAdd({ track: 'work', text: 'ship it', scope: { projectId: 'p1' } })
    expect(mock.last('todo.add')?.payload).toEqual({ track: 'work', text: 'ship it', scope: { projectId: 'p1' } })
  })

  it('rooms.create / rooms.post / rooms.spawn send their own author field', async () => {
    const { mock, api } = transport()
    await api.roomsCreate('Standups')
    expect(mock.last('rooms.create')?.payload).toEqual({ title: 'Standups' })
    await api.roomsPost('standups', 'hello', { sessionId: 'sess-77', label: 'worker-1' })
    expect(mock.last('rooms.post')?.payload).toEqual({ roomId: 'standups', text: 'hello', sessionId: 'sess-77', label: 'worker-1' })
    await api.roomsSpawn({ roomId: 'standups', label: 'reviewer', prompt: 'review' })
    expect(mock.last('rooms.spawn')?.payload).toEqual({ roomId: 'standups', label: 'reviewer', prompt: 'review' })
  })

  it('jobs.cancel sends jobId', async () => {
    const { mock, api } = transport()
    await api.jobsCancel('j-1')
    expect(mock.last('jobs.cancel')?.payload).toEqual({ jobId: 'j-1' })
  })
})

describe('failure modes', () => {
  it('an unmounted endpoint is a typed failure with the host code', async () => {
    const { api } = transport()
    const result = await createCortexApi(createMockTransport({ missing: ['todo.list'] }).call).todoList()
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error.code).toBe('unknown-endpoint')
      expect(result.error.message).toContain('todo.list')
    }
    expect(api.ping).toBeTypeOf('function')
  })

  it('a transport that throws never escapes as a throw', async () => {
    const api = createCortexApi(createMockTransport({ throwing: ['memory.list'] }).call)
    const result = await api.memoryList()
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.error.code).toBe('transport')
  })

  it('a call that never answers becomes a timeout, not a hang', async () => {
    const api = createCortexApi(() => new Promise<never>(() => {}), { timeoutMs: 25 })
    const started = Date.now()
    const result = await api.ping()
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.error.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('prompts.* answers as wave-2-absent without breaking the adapter', async () => {
    const api = createCortexApi(createMockTransport({ missing: ['prompts.list', 'prompts.get'] }).call)
    const list = await api.promptsList()
    const get = await api.promptsGet('pr-1')
    expect(list.ok).toBe(false)
    expect(get.ok).toBe(false)
    if (list.ok === false) expect(list.error.code).toBe('unknown-endpoint')
  })

  it('the write-channel probe answers unknown-endpoint, which proves dispatch', async () => {
    const { mock, api } = transport()
    const result = await api.probeWriteChannel('__cortex_probe__')
    expect(mock.last('__cortex_probe__')?.channel).toBe(CORTEX_WRITE_CHANNEL)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.error.code).toBe('unknown-endpoint')
  })
})
