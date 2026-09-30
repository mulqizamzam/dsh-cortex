import { afterEach, describe, expect, it } from 'vitest'
import * as memoryModule from '../../src/host/modules/memory/index.ts'
import { removeTempRoot } from '../helpers.ts'
import { fakeAgent, makeHarness } from './fixture.ts'
import type { Harness } from './fixture.ts'

/**
 * H3: `cortex_memory_delete` listed every entry — twice (archived + active) —
 * on BOTH steps, then threw the listing away on the confirm step. The second
 * step is the one that deletes, and the entry it deletes is named by the id
 * already in hand, so the listing only ever feeds the human-readable warning
 * of the first step.
 *
 * This file pins that: the token step lists, the confirm step does not, and the
 * refusal path does not either. A delete that still works while listing nothing
 * is the proof the listing was never load-bearing there.
 */

let harness: Harness | undefined

afterEach(async () => {
  if (harness !== undefined) await removeTempRoot(harness.root)
  harness = undefined
})

async function boot(): Promise<Harness> {
  harness = await makeHarness()
  memoryModule.apply(harness.deps, { scopes: harness.scopes })
  return harness
}

async function run(host: Harness, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const definition = host.host.tools.get(name)
  expect(definition, `tool ${name} must be registered`).toBeDefined()
  const execution = { signal: new AbortController().signal, agent: fakeAgent(host.cwd) }
  return await definition?.execute(args as never, execution as never) as Record<string, any>
}

/** Count `listEntries` calls without changing what they return. */
function countListings(host: Harness): () => number {
  const store = host.store
  const original = store.listEntries.bind(store)
  let calls = 0
  ;(store as unknown as { listEntries: typeof store.listEntries }).listEntries = filter => {
    calls += 1
    return original(filter)
  }
  return () => calls
}

describe('H3: the confirm step deletes without listing', () => {
  it('lists for the warning, then lists NOTHING on the token step', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'global' }, content: 'to be erased', importance: 3 })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''
    const listings = countListings(host)

    const first = await run(host, 'cortex_memory_delete', { id })
    expect(first.ok).toBe(true)
    expect(first.deleted).toBe(false)
    expect(listings(), 'the token step must look the entry up to warn about it').toBeGreaterThan(0)
    expect(String(first.warning)).toContain(id)

    const before = listings()
    const second = await run(host, 'cortex_memory_delete', { id, confirm: first.token })
    expect(second.ok).toBe(true)
    expect(second.deleted).toBe(true)
    expect(listings() - before, 'the confirm step must not list entries').toBe(0)

    const left = await host.store.listEntries({ track: 'global', branch: null })
    if (left.ok) expect(left.data.entries).toHaveLength(0)
  })

  it('refuses a wrong token without listing anything', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'user' }, content: 'survivor', importance: 2 })
    const id = added.ok ? added.data.id : ''
    await run(host, 'cortex_memory_delete', { id })
    const listings = countListings(host)

    const refused = await run(host, 'cortex_memory_delete', { id, confirm: 'not-the-token' })
    expect(refused.ok).toBe(false)
    expect(listings(), 'a refused confirm must not list entries').toBe(0)

    const left = await host.store.listEntries({ track: 'user', branch: null })
    if (left.ok) expect(left.data.entries).toHaveLength(1)
  })

  it('still deletes an ARCHIVED entry: the warning finds it, the token step removes it', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'global' }, content: 'archived fact', importance: 3 })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''
    const archived = await host.store.archiveEntry(id)
    expect(archived.ok).toBe(true)

    const first = await run(host, 'cortex_memory_delete', { id })
    expect(first.ok).toBe(true)
    expect(String(first.warning)).toContain('archived')

    const second = await run(host, 'cortex_memory_delete', { id, confirm: first.token })
    expect(second.ok).toBe(true)
    expect(second.deleted).toBe(true)
    const gone = await host.store.listEntries({ track: 'global', archived: true, branch: null })
    if (gone.ok) expect(gone.data.entries).toHaveLength(0)
  })

  it('a token issued for an id that no longer exists fails honestly, without a listing', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'global' }, content: 'vanishes', importance: 3 })
    const id = added.ok ? added.data.id : ''
    const first = await run(host, 'cortex_memory_delete', { id })
    expect(first.ok).toBe(true)
    // Something else removed it in between: the token is still valid, the entry gone.
    expect((await host.store.deleteEntry(id)).ok).toBe(true)

    const listings = countListings(host)
    const second = await run(host, 'cortex_memory_delete', { id, confirm: first.token })
    expect(second.ok).toBe(false)
    expect(listings(), 'a confirm step must not list entries').toBe(0)
  })
})
