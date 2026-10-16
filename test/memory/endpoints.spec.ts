import { afterEach, describe, expect, it } from 'vitest'
import {
  READ_ENDPOINT_NAMES,
  WRITE_ENDPOINT_NAMES,
  readEndpoints,
  writeEndpoints,
} from '../../src/host/modules/memory/endpoints.ts'
import { apply } from '../../src/host/modules/memory/index.ts'
import { LIST_CAP } from '../../src/host/store.ts'
import { pluginErrorCode } from '../../src/client/api.ts'
import { removeTempRoot } from '../helpers.ts'
import { fakeAgent, makeHarness, seedEntries } from './fixture.ts'
import type { Harness } from './fixture.ts'

/**
 * The RPC surface, called exactly the way the parent's merged dispatch will call
 * it: `(payload, deps)`. Names are the frozen ones in .dev/RPC-ENDPOINTS.md;
 * these tests are what M7's mock adapter has to agree with.
 */

let harness: Harness | undefined

afterEach(async () => {
  if (harness !== undefined) await removeTempRoot(harness.root)
  harness = undefined
})

async function boot(config: Parameters<typeof makeHarness>[0] = {}, scope: { pid?: string; branch?: string | null } = {}): Promise<Harness> {
  harness = await makeHarness(config, { pid: scope.pid ?? 'rpcproject000', branch: scope.branch === undefined ? null : scope.branch })
  apply(harness.deps, { scopes: harness.scopes })
  return harness
}

async function call(which: 'read' | 'write', endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: any; error?: { code?: string; message: string } }> {
  const host = harness as Harness
  const table = which === 'read' ? readEndpoints : writeEndpoints
  const handler = table[endpoint]
  expect(handler, `${endpoint} must be exported`).toBeTypeOf('function')
  return await handler(payload, host.deps) as never
}

/**
 * The plugin's own code, read the way the CLIENT reads it.
 *
 * The host's `error.code` is a closed 40-member session/workspace vocabulary
 * with no slot for a plugin's domain errors (rpc-error.ts), so the plugin
 * projects onto it and keeps its own code in the message. Asserting
 * `error.code` directly pinned a value the host rejects — which is exactly the
 * reply it used to throw away, taking the message with it.
 */
function pluginCode(result: { error?: { code?: string; message?: string } }): string {
  const error = result.error
  return pluginErrorCode({ code: error?.code ?? '', message: error?.message ?? '' })
}

/** The id-addressing most of these tests need. */
async function seedOne(track: 'user' | 'global' | 'project', content: string, extra: Record<string, unknown> = {}): Promise<string> {
  const host = harness as Harness
  const added = await host.store.addEntry({
    scope: { track, ...(track === 'project' ? { pid: 'rpcproject000' } : {}) },
    content,
    importance: 4,
    ...(extra as { branches?: string[]; tags?: string[] }),
  })
  if (!added.ok) throw new Error(added.error)
  return added.data.id
}

describe('endpoint names (the M7 contract)', () => {
  it('exports exactly the frozen read and write names', async () => {
    await boot()
    expect(READ_ENDPOINT_NAMES).toEqual(['memory.list', 'memory.search'])
    expect(WRITE_ENDPOINT_NAMES).toEqual(['memory.update', 'memory.archive', 'memory.restore', 'memory.delete', 'pending.approve', 'pending.reject'])
  })
})

describe('memory.list / memory.search', () => {
  it('lists rows and carries the honesty flags', async () => {
    const host = await boot()
    await seedEntries(host.store, 4, { track: 'global' })
    const result = await call('read', 'memory.list', { track: 'global' })
    expect(result.ok).toBe(true)
    expect(result.value.entries).toHaveLength(4)
    expect(result.value.truncated).toBe(false)
    expect(result.value.branch).toBeNull()
  })

  it('shows branch-scoped rows only for the branch named in the payload', async () => {
    await boot()
    await seedOne('global', 'scoped to feat-x only', { branches: ['feat-x'] })
    const onFeat = await call('read', 'memory.list', { track: 'global', branch: 'feat-x' })
    expect(onFeat.value.entries).toHaveLength(1)
    const onMain = await call('read', 'memory.list', { track: 'global', branch: 'main' })
    expect(onMain.value.entries).toHaveLength(0)
    const unknown = await call('read', 'memory.list', { track: 'global', branch: null })
    expect(unknown.value.entries).toHaveLength(0)
    // No `branch` key at all means "show every scope", not "guess one".
    const unfiltered = await call('read', 'memory.list', { track: 'global' })
    expect(unfiltered.value.entries).toHaveLength(1)
  })

  it('surfaces the listing cap instead of hiding it', async () => {
    const host = await boot()
    await seedEntries(host.store, LIST_CAP + 3, { track: 'global' })
    const result = await call('read', 'memory.list', { track: 'global' })
    expect(result.ok).toBe(true)
    expect(result.value.truncated).toBe(true)
    expect(result.value.entries.length).toBeLessThanOrEqual(LIST_CAP)
  })

  it('search returns the frozen hit shape', async () => {
    const host = await boot()
    const id = await seedOne('global', 'the deploy gate lives behind a flag')
    const result = await call('read', 'memory.search', { query: 'deploy gate' })
    expect(result.ok).toBe(true)
    const hit = result.value.hits[0]
    expect(Object.keys(hit).sort()).toEqual(['archived', 'branches', 'id', 'score', 'snippet', 'track'])
    expect(hit.id).toBe(id)
    expect(hit.track).toBe('global')
    expect(hit.score).toBeGreaterThan(0)
    expect(result.value.candidates).toBe(1)
    expect(result.value.text.length).toBeLessThanOrEqual(host.config.caps.searchResultChars)
  })

  it('an empty query is an error object, never a stack', async () => {
    await boot()
    for (const payload of [{}, { query: '   ' }, { query: 7 }, 'not-an-object', null, [1, 2]]) {
      const result = await call('read', 'memory.search', payload)
      expect(result.ok).toBe(false)
      expect(typeof result.error?.message).toBe('string')
      expect(result.error?.message).not.toBe('')
    }
  })
})

describe('write endpoints', () => {
  it('update applies the nested patch from the contract', async () => {
    const host = await boot()
    const id = await seedOne('global', 'before the change')
    const result = await call('write', 'memory.update', { id, patch: { content: 'after the change', importance: 5, tags: ['ops'] } })
    expect(result.ok).toBe(true)
    expect(result.value.content).toBe('after the change')
    const list = await host.store.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries[0]?.importance).toBe(5)
    const missing = await call('write', 'memory.update', { id: 'ffffffffffff', patch: { content: 'x' } })
    expect(missing.ok).toBe(false)
    expect(pluginCode(missing)).toBe('not-found')
  })

  it('archive then restore round-trips through the endpoints', async () => {
    const host = await boot()
    const id = await seedOne('project', 'a project fact to hide')
    expect((await call('write', 'memory.archive', { id, projectId: 'rpcproject000' })).ok).toBe(true)
    const active = await host.store.listEntries({ track: 'project', pid: 'rpcproject000', branch: null })
    if (active.ok) expect(active.data.entries).toHaveLength(0)
    const archived = await call('read', 'memory.list', { track: 'project', projectId: 'rpcproject000', archived: true })
    expect(archived.value.entries).toHaveLength(1)
    expect(archived.value.entries[0].content).toBe('a project fact to hide')
    expect((await call('write', 'memory.restore', { id, projectId: 'rpcproject000' })).ok).toBe(true)
    const back = await host.store.listEntries({ track: 'project', pid: 'rpcproject000', branch: null })
    if (back.ok) expect(back.data.entries[0]?.content).toBe('a project fact to hide')
  })

  it('delete requires the frozen confirm', async () => {
    const host = await boot()
    const id = await seedOne('global', 'do not delete this one')
    const first = await call('write', 'memory.delete', { id })
    expect(first.ok).toBe(true)
    expect(first.value.deleted).toBe(false)
    expect(typeof first.value.token).toBe('string')
    const wrong = await call('write', 'memory.delete', { id, confirm: 'yes' })
    expect(wrong.ok).toBe(false)
    expect(pluginCode(wrong)).toBe('bad-confirm')
    // The RPC path uses the same issued token (no frozen literal).
    const confirmed = await call('write', 'memory.delete', { id, confirm: first.value.token })
    expect(confirmed.value.deleted).toBe(true)
    const list = await host.store.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(0)
  })

  it('pending.approve turns a memory proposal into an entry, and refuses the others', async () => {
    const host = await boot()
    const proposed = await host.store.addPending({ kind: 'memory', proposal: { track: 'global', content: 'a reviewed fact', importance: 4 }, fromSessionId: 'session-1' })
    expect(proposed.ok).toBe(true)
    const approved = await call('write', 'pending.approve', { id: proposed.ok ? proposed.data.id : '' })
    expect(approved.ok).toBe(true)
    expect(approved.value.track).toBe('global')
    const list = await host.store.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries[0]?.content).toBe('a reviewed fact')
    // The gate is write-origin, not a prompt: an AI proposal lands as ai-confirmed.
    if (list.ok) expect(list.data.entries[0]?.origin).toBe('ai-confirmed')
    const decided = await host.store.listPending({ status: 'approved' })
    if (decided.ok) expect(decided.data).toHaveLength(1)

    const todo = await host.store.addPending({ kind: 'todo', proposal: { track: 'work', text: 'not a memory' } })
    const refused = await call('write', 'pending.approve', { id: todo.ok ? todo.data.id : '' })
    expect(refused.ok).toBe(false)
    expect(pluginCode(refused)).toBe('wrong-kind')
    const nothing = await call('write', 'pending.approve', { id: 'abcdef123456' })
    expect(pluginCode(nothing)).toBe('not-found')
  })

  it('a project-scoped proposal approves into its own project only', async () => {
    const host = await boot()
    const proposed = await host.store.addPending({
      kind: 'memory',
      proposal: { track: 'project', content: 'a project rule from a proposal', importance: 4, branches: ['feat-x'] },
      fromSessionId: 'session-1',
    })
    const approved = await call('write', 'pending.approve', { id: proposed.ok ? proposed.data.id : '', projectId: 'rpcproject000' })
    expect(approved.ok).toBe(true)
    expect(approved.value.track).toBe('project')
    const inProject = await host.store.listEntries({ track: 'project', pid: 'rpcproject000', branch: 'feat-x' })
    if (inProject.ok) expect(inProject.data.entries).toHaveLength(1)
    const elsewhere = await host.store.listEntries({ track: 'project', pid: 'otherproject000', branch: 'feat-x' })
    if (elsewhere.ok) expect(elsewhere.data.entries).toHaveLength(0)
    // Approving the same row twice must not duplicate the memory.
    const again = await call('write', 'pending.approve', { id: proposed.ok ? proposed.data.id : '', projectId: 'rpcproject000' })
    expect(again.ok).toBe(false)
    expect(pluginCode(again)).toBe('not-found')
  })

  it('a project-scoped proposal without a project in scope is refused, not moved', async () => {
    const host = await boot()
    const proposed = await host.store.addPending({ kind: 'memory', proposal: { track: 'project', content: 'orphan rule' } })
    const refused = await call('write', 'pending.approve', { id: proposed.ok ? proposed.data.id : '' })
    expect(refused.ok).toBe(false)
    expect(String(refused.error?.message)).toContain('no project is in scope')
    // Refusal must not have written the row anywhere, and must not decide it.
    const inProject = await host.store.listEntries({ track: 'project', pid: 'rpcproject000', branch: null })
    if (inProject.ok) expect(inProject.data.entries).toHaveLength(0)
    const stillPending = await host.store.listPending({ status: 'pending' })
    if (stillPending.ok) expect(stillPending.data).toHaveLength(1)
  })

  it('pending.reject records the decision for any kind', async () => {
    const host = await boot()
    const proposed = await host.store.addPending({ kind: 'memory', proposal: { track: 'user', content: 'noise' } })
    const rejected = await call('write', 'pending.reject', { id: proposed.ok ? proposed.data.id : '', reason: 'not useful' })
    expect(rejected.ok).toBe(true)
    expect(rejected.value.status).toBe('rejected')
    const list = await host.store.listEntries({ track: 'user', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(0)
  })

  it('a write through RPC is visible to the injection on the next render', async () => {
    const host = await boot()
    const injectorId = await seedOne('global', 'written by the panel')
    await call('write', 'memory.archive', { id: injectorId })
    const context = host.host.contexts[0]
    expect(context).toBeDefined()
    context?.text({ agent: fakeAgent(host.cwd) })
    let rendered = ''
    for (let attempt = 0; attempt < 40 && rendered === ''; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      rendered = context?.text({ agent: fakeAgent(host.cwd) }) ?? ''
    }
    // The archive removed it from the injected set; the block reflects that.
    expect(rendered).toContain('Long-term memory')
    expect(rendered).not.toContain('written by the panel')
  })

  it('no handler ever throws, whatever the payload', async () => {
    await boot()
    const hostile: unknown[] = [undefined, null, 0, '', 'string', [], [{}], { id: {} }, { id: '../../../../etc/passwd' }, { id: 'ok', confirm: { nope: true } }]
    for (const name of [...READ_ENDPOINT_NAMES, ...WRITE_ENDPOINT_NAMES]) {
      for (const payload of hostile) {
        const which = READ_ENDPOINT_NAMES.includes(name) ? 'read' : 'write'
        const result = await call(which, name, payload)
        expect(typeof result.ok).toBe('boolean')
        if (result.ok === false) expect(typeof result.error?.message).toBe('string')
        expect(JSON.stringify(result)).not.toContain('{{')
      }
    }
  })
})
