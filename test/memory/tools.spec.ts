import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INJECT_LABEL } from '../../src/host/config.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { TOOLS, apply } from '../../src/host/modules/memory/index.ts'
import { MEMORY_CONTEXT, MEMORY_CONTEXT_ORDER } from '../../src/host/modules/memory/index.ts'
import * as memoryModule from '../../src/host/modules/memory/index.ts'
import type { CortexModule } from '../../src/host/types.ts'
import { removeTempRoot } from '../helpers.ts'
import { fakeAgent, makeHarness, seedEntries } from './fixture.ts'
import type { Harness } from './fixture.ts'

/**
 * The tool surface, driven exactly the way the host drives it: `apply(deps)`
 * registers the tools, then `definition.execute(args, { agent })` is called with
 * a fake agent so scope resolution runs off `agent.session.header.cwd`.
 */

let harness: Harness | undefined

afterEach(async () => {
  if (harness !== undefined) await removeTempRoot(harness.root)
  harness = undefined
})

async function boot(config: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  harness = await makeHarness(config)
  apply(harness.deps, { scopes: harness.scopes })
  return harness
}

async function run(name: string, args: Record<string, unknown>, agent = true): Promise<Record<string, any>> {
  const host = harness as Harness
  const definition = host.host.tools.get(name)
  expect(definition, `tool ${name} must be registered`).toBeDefined()
  const execution = { signal: new AbortController().signal, ...(agent ? { agent: fakeAgent(host.cwd) } : {}) }
  return await definition?.execute(args as never, execution as never) as Record<string, any>
}

describe('memory module wiring', () => {
  it('satisfies the parent wiring contract: MODULES.push(memoryModule) type-checks and runs', async () => {
    const fresh = await makeHarness()
    harness = fresh
    const mod: CortexModule = memoryModule
    expect(mod.name).toBe('memory')
    expect(() => mod.apply(fresh.deps)).not.toThrow()
    // The wiring loop reads TOOLS off the module file to report tool ownership.
    expect((memoryModule as { TOOLS?: readonly string[] }).TOOLS).toEqual([...TOOLS])
    expect(harness.host.tools.size).toBe(TOOLS.length)
  })


  it('registers the seven tools and one injection context', async () => {
    const host = await boot()
    expect([...TOOLS]).toEqual([
      'cortex_memory_remember',
      'cortex_memory_search',
      'cortex_memory_list',
      'cortex_memory_archive',
      'cortex_memory_restore',
      'cortex_memory_delete',
      'cortex_memory_update',
    ])
    for (const tool of TOOLS) expect(host.host.tools.has(tool)).toBe(true)
    expect(host.host.tools.size).toBe(TOOLS.length)
    expect(host.host.contexts).toHaveLength(1)
    expect(host.host.contexts[0]?.name).toBe(MEMORY_CONTEXT)
    expect(host.host.contexts[0]?.order).toBe(MEMORY_CONTEXT_ORDER)
  })

  it('a second apply() on the same context registers neither a duplicate tool nor a duplicate context', async () => {
    const host = await boot()
    expect(() => apply(host.deps, { scopes: host.scopes })).toThrow(/already registered/)
    // registerOnce keeps the single registration: the context list never grew.
    expect(host.host.contexts).toHaveLength(1)
  })

  it('a missing systemPrompt service costs the injection only, never the tools', async () => {
    harness = await makeHarness({}, { noSystemPrompt: true })
    apply(harness.deps, { scopes: harness.scopes })
    expect(harness.host.contexts).toHaveLength(0)
    expect(harness.host.tools.size).toBe(TOOLS.length)
    expect(harness.host.warnings.join(' ')).toContain('no systemPrompt.context seam')
  })

  it('no tool or parameter description carries a brace pair (#53)', async () => {
    const host = await boot()
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
      : Array.isArray(value) ? value.flatMap(strings)
        : value !== null && typeof value === 'object' ? Object.values(value as Record<string, unknown>).flatMap(strings) : []
    for (const definition of host.host.tools.values()) {
      for (const text of strings(definition.description).concat(strings(definition.parameters))) {
        expect(text.includes('{{') || text.includes('}}')).toBe(false)
      }
    }
  })

  it('the injected block is honest, brace-free and arrives one render ahead', async () => {
    const host = await boot()
    await host.store.addEntry({ scope: { track: 'user' }, content: 'the build runs pnpm test', importance: 5 })
    const context = host.host.contexts[0]
    expect(context).toBeDefined()
    const assembly = { agent: fakeAgent(host.cwd) }
    // The callback is synchronous: it renders in the background and withholds
    // memory until a block exists, instead of blocking or throwing.
    expect(context?.text(assembly)).toBe('')
    let rendered = ''
    for (let attempt = 0; attempt < 40 && rendered === ''; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      rendered = context?.text(assembly) ?? ''
    }
    expect(rendered.startsWith(INJECT_LABEL)).toBe(true)
    expect(rendered).toContain('the build runs pnpm test')
    expect(rendered).not.toContain('{{')
  })

  it('a context callback never throws, even with a broken config read', async () => {
    const host = await boot()
    const context = host.host.contexts[0]
    expect(context?.text(undefined)).toBe('')
    expect(context?.text({ agent: null })).toBe('')
    expect(context?.text({ agent: { session: {} } })).toBe('')
  })
})

describe('cortex_memory_remember: the pending gate (P3, C-03)', () => {
  it('defaults to a proposal, not a memory', async () => {
    const host = await boot()
    const result = await run('cortex_memory_remember', { track: 'global', content: 'the API gateway lives in env vars', importance: 4 })
    expect(result.ok).toBe(true)
    expect(result.accepted).toBe('pending')
    expect(typeof result.id).toBe('string')
    const pending = await host.store.listPending({})
    expect(pending.ok === true).toBe(true)
    if (pending.ok) expect(pending.data).toHaveLength(1)
    expect(pending.ok ? pending.data[0]?.kind : null).toBe('memory')
    expect(pending.ok ? pending.data[0]?.proposal.content : '').toBe('the API gateway lives in env vars')
    // Nothing may be visible to the renderer yet.
    const list = await host.store.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(0)
    expect(result.text.toLowerCase()).toContain('is not memory yet')
  })

  it('stores directly only when memory.autoAccept is on, as ai-confirmed', async () => {
    const host = await boot()
    host.setConfig({ memory: { autoAccept: true } })
    const result = await run('cortex_memory_remember', { track: 'user', content: 'prefers Portuguese comments' })
    expect(result.ok).toBe(true)
    expect(result.accepted).toBe('stored')
    const list = await host.store.listEntries({ track: 'user', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(1)
    expect(list.ok ? list.data.entries[0]?.origin : '').toBe('ai-confirmed')
    const pending = await host.store.listPending({})
    expect(pending.ok && pending.data).toHaveLength(0)
  })

  it('a project track needs a resolvable project, and says so', async () => {
    const host = await boot()
    const result = await run('cortex_memory_remember', { track: 'project', content: 'release train is Thursdays' }, false)
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('no project could be resolved')
  })

  it('clamps long content instead of refusing, and reports it', async () => {
    const host = await boot({ caps: { ...DEFAULT_CAPS, entryChars: 60 } })
    const result = await run('cortex_memory_remember', { track: 'global', content: `fact ${'x'.repeat(400)}` })
    expect(result.ok).toBe(true)
    expect(result.clamped).toBe(true)
    expect(String(result.content).length).toBeLessThanOrEqual(60)
    expect(result.text).toContain('clamped')
  })

  it('a project-track write records projects/<pid>/meta.json (DESIGN §2)', async () => {
    const host = await boot({ memory: { autoAccept: true } })
    const result = await run('cortex_memory_remember', { track: 'project', content: 'the release train leaves Thursdays' })
    expect(result.ok).toBe(true)
    const meta = JSON.parse(await readFile(join(host.root, 'projects', 'testproject000', 'meta.json'), 'utf8')) as Record<string, unknown>
    expect(meta.pid).toBe('testproject000')
    expect(JSON.stringify(meta)).not.toContain('{{')
  })

  it('rejects nonsense arguments as sentences, never as exceptions', async () => {
    await boot()
    expect((await run('cortex_memory_remember', { track: 'sideways', content: 'x' })).error).toMatch(/track must be one of/)
    expect((await run('cortex_memory_remember', { track: 'user' })).error).toMatch(/content is required/)
    expect((await run('cortex_memory_remember', { track: 'user', content: 'x', tags: 'not-a-list' })).error).toMatch(/tags must be an array/)
    expect((await run('cortex_memory_remember', { content: 'x' })).error).toMatch(/track must be one of/)
  })
})

describe('cortex_memory_list / search / update / archive / restore / delete', () => {
  it('lists what is stored, capped and honest about the branch scope', async () => {
    const host = await boot()
    await seedEntries(host.store, 3, { track: 'global' })
    const listed = await run('cortex_memory_list', {})
    expect(listed.ok).toBe(true)
    expect(listed.entries).toHaveLength(3)
    expect(String(listed.text)).toContain('3 entries')
    const globalOnly = await run('cortex_memory_list', { track: 'global' })
    expect(globalOnly.entries).toHaveLength(3)
    const userOnly = await run('cortex_memory_list', { track: 'user' })
    expect(userOnly.entries).toHaveLength(0)
  })

  it('search returns snippets inside the character cap and names the leftovers', async () => {
    const host = await boot({ caps: { ...DEFAULT_CAPS, searchResultChars: 400 } })
    for (let index = 0; index < 30; index += 1) {
      await host.store.addEntry({ scope: { track: 'global' }, content: `release note ${index} mentions the deploy gate`, importance: 3 })
    }
    const result = await run('cortex_memory_search', { query: 'release deploy gate' })
    expect(result.ok).toBe(true)
    expect(String(result.text).length).toBeLessThanOrEqual(400)
    expect(result.candidates).toBe(30)
    expect(result.shown).toBeLessThan(result.candidates)
    expect(String(result.text)).toContain('more match(es) omitted')
    expect(String(result.text)).toContain('release note')
  })

  it('search finds archived rows only when asked, and ranks the phrase first', async () => {
    const host = await boot()
    const active = await host.store.addEntry({ scope: { track: 'global' }, content: 'the deploy gate is behind a flag', importance: 4 })
    const old = await host.store.addEntry({ scope: { track: 'global' }, content: 'an older deploy gate note, now archived', importance: 2 })
    expect(active.ok && old.ok).toBe(true)
    if (old.ok) await host.store.archiveEntry(old.data.id)
    const without = await run('cortex_memory_search', { query: 'deploy gate' })
    expect(without.hits.every((hit: { archived: boolean }) => hit.archived === false)).toBe(true)
    const withArchive = await run('cortex_memory_search', { query: 'deploy gate', includeArchive: true })
    expect(withArchive.hits.some((hit: { archived: boolean }) => hit.archived === true)).toBe(true)
    expect(withArchive.hits[0]?.id).toBe(active.ok ? active.data.id : undefined)
  })

  it('an empty or nonsense query is a message, not a crash', async () => {
    await boot()
    expect((await run('cortex_memory_search', {})).error).toMatch(/query is required/)
    expect((await run('cortex_memory_search', { query: 42 })).error).toMatch(/query must be a string/)
    expect((await run('cortex_memory_search', { query: 'nothing matches this', tracks: ['nope'] })).error).toMatch(/tracks entry must be one of/)
  })

  it('updates content, importance and branch scope by id', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'global' }, content: 'stale fact', importance: 2, branches: ['old-branch'] })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''
    const updated = await run('cortex_memory_update', { id, content: 'fresh fact', importance: 5, branches: [] })
    expect(updated.ok).toBe(true)
    expect(updated.content).toBe('fresh fact')
    const list = await host.store.listEntries({ track: 'global', branch: 'anything' })
    if (list.ok) expect(list.data.entries).toHaveLength(1)
    expect(list.ok ? list.data.entries[0]?.content : '').toBe('fresh fact')
    expect(list.ok ? list.data.entries[0]?.branches : ['unset']).toBeUndefined()
    expect((await run('cortex_memory_update', { id: 'deadbeefdead', content: 'x' })).error).toMatch(/no memory entry with id/)
    expect((await run('cortex_memory_update', { id })).error).toMatch(/nothing to update/)
  })

  it('archive hides an entry from injection and restore brings it back unchanged', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'global' }, content: 'a fact worth hiding', importance: 4, tags: ['ops'] })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''
    const original = added.ok ? added.data : undefined

    expect((await run('cortex_memory_archive', { id })).ok).toBe(true)
    const active = await host.store.listEntries({ track: 'global', branch: null })
    if (active.ok) expect(active.data.entries).toHaveLength(0)
    const archived = await run('cortex_memory_list', { track: 'global', archived: true })
    expect(archived.entries).toHaveLength(1)
    expect(archived.entries[0].content).toBe(original?.content)
    expect(archived.entries[0].tags).toEqual(original?.tags)
    expect(archived.entries[0].archivedAt).toBeTypeOf('string')

    expect((await run('cortex_memory_restore', { id })).ok).toBe(true)
    const back = await host.store.listEntries({ track: 'global', branch: null })
    if (back.ok) expect(back.data.entries).toHaveLength(1)
    expect(back.ok ? back.data.entries[0]?.content : '').toBe(original?.content)
    expect(back.ok ? back.data.entries[0]?.archivedAt : 'set').toBeUndefined()
    // Round trip kept every field and hid it in between: no data lost.
    const again = await run('cortex_memory_restore', { id })
    expect(again.ok).toBe(false)
    expect(String(again.error)).toContain('archived entry with id')
  })

  it('delete needs a second call carrying the token it was given', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'global' }, content: 'a fact to erase', importance: 3 })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''

    const first = await run('cortex_memory_delete', { id })
    expect(first.ok).toBe(true)
    expect(first.deleted).toBe(false)
    expect(first.token).toBeTypeOf('string')
    expect(first.warning).toContain('a fact to erase')
    const still = await host.store.listEntries({ track: 'global', branch: null })
    if (still.ok) expect(still.data.entries).toHaveLength(1)

    expect((await run('cortex_memory_delete', { id, confirm: 'cf_wrongtoken' })).error).toMatch(/is not the single-use token issued for this id/)
    expect((await run('cortex_memory_delete', { id: '../escape', confirm: 'DELETE' })).error).toMatch(/must be an entry id/)

    const second = await run('cortex_memory_delete', { id, confirm: first.token })
    expect(second.ok).toBe(true)
    expect(second.deleted).toBe(true)
    const gone = await host.store.listEntries({ track: 'global', branch: null })
    if (gone.ok) expect(gone.data.entries).toHaveLength(0)
    // A used token never works again, and the id is already gone.
    expect((await run('cortex_memory_delete', { id, confirm: first.token })).ok).toBe(false)
  })

  it('refuses a hard-coded literal and only deletes with the issued token', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'user' }, content: 'erase me via the token', importance: 2 })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''
    // The old frozen literal "DELETE" is no longer accepted (honest two-step).
    const literal = await run('cortex_memory_delete', { id, confirm: 'DELETE' })
    expect(literal.ok).toBe(false)
    expect(String(literal.error)).toMatch(/is not the single-use token/)
    // The two-step token flow still deletes.
    const first = await run('cortex_memory_delete', { id })
    expect(first.ok).toBe(true)
    const result = await run('cortex_memory_delete', { id, confirm: first.token })
    expect(result.deleted).toBe(true)
    const list = await host.store.listEntries({ track: 'user', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(0)
  })

  it('every tool result is brace-free text', async () => {
    const host = await boot({ memory: { autoAccept: true } })
    const planted = 'the runner reads {{session}} and {{{{nested}}}} end to end'
    const stored = await run('cortex_memory_remember', { track: 'global', content: planted })
    expect(stored.ok).toBe(true)
    const listed = await run('cortex_memory_list', { track: 'global' })
    const found = await run('cortex_memory_search', { query: 'runner nested' })
    const updated = await run('cortex_memory_update', { id: stored.id, content: planted })
    // Assert on STRING LEAVES: JSON syntax legitimately emits adjacent braces
    // when nested objects close, and that is not model-visible text.
    const leaves = (value: unknown): string[] => typeof value === 'string' ? [value]
      : Array.isArray(value) ? value.flatMap(leaves)
        : value !== null && typeof value === 'object' ? Object.values(value as Record<string, unknown>).flatMap(leaves) : []
    for (const value of [stored, listed, found, updated]) {
      const texts = leaves(value)
      expect(texts.length).toBeGreaterThan(0)
      for (const text of texts) {
        expect(text).not.toContain('{{')
        expect(text).not.toContain('}}')
      }
    }
    expect(String(stored.content)).toContain('{ {session} }')
    expect(found.hits[0]?.snippet).toContain('{ {session} }')
  })
})
