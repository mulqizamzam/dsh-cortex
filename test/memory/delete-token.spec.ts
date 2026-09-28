import { afterEach, describe, expect, it } from 'vitest'
import * as memoryModule from '../../src/host/modules/memory/index.ts'
import { removeTempRoot } from '../helpers.ts'
import { fakeAgent, makeHarness } from './fixture.ts'
import type { Harness } from './fixture.ts'

/**
 * Regression for REVIEW-R2 HON-3: `cortex_memory_delete` must delete ONLY when
 * the second call presents the exact single-use token the first call issued.
 * A guessed value, the old frozen literal "DELETE", or a reused/expired token
 * must all be refused (ok:false) and leave the entry intact.
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

async function run(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const host = harness as Harness
  const definition = host.host.tools.get(name)
  expect(definition, `tool ${name} must be registered`).toBeDefined()
  const execution = { signal: new AbortController().signal, agent: fakeAgent(host.cwd) }
  return await definition?.execute(args as never, execution as never) as Record<string, any>
}

describe('cortex_memory_delete two-step token enforcement', () => {
  it('refuses a guessed/arbitrary/literal confirm and deletes only with the issued token', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'global' }, content: 'a fact to erase', importance: 3 })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''

    // First call returns a token, deletes nothing, leaves state intact.
    const first = await run('cortex_memory_delete', { id })
    expect(first.ok).toBe(true)
    expect(first.deleted).toBe(false)
    expect(typeof first.token).toBe('string')
    const list = await host.store.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(1)

    // The old frozen literal "DELETE" is NO LONGER accepted (honest two-step).
    const literal = await run('cortex_memory_delete', { id, confirm: 'DELETE' })
    expect(literal.ok).toBe(false)
    expect(String(literal.error)).toMatch(/is not the single-use token/)
    if (list.ok) expect(list.data.entries).toHaveLength(1)

    // An arbitrary wrong token is refused too.
    const wrong = await run('cortex_memory_delete', { id, confirm: 'cf_zzzzzzzz' })
    expect(wrong.ok).toBe(false)
    expect(String(wrong.error)).toMatch(/is not the single-use token/)

    // The exact issued token deletes.
    const second = await run('cortex_memory_delete', { id, confirm: first.token })
    expect(second.ok).toBe(true)
    expect(second.deleted).toBe(true)
    const gone = await host.store.listEntries({ track: 'global', branch: null })
    if (gone.ok) expect(gone.data.entries).toHaveLength(0)

    // The token is single-use: replaying it fails.
    const replay = await run('cortex_memory_delete', { id, confirm: first.token })
    expect(replay.ok).toBe(false)
  })

  it('a wrong-token call does not consume the real token (the real one still works)', async () => {
    const host = await boot()
    const added = await host.store.addEntry({ scope: { track: 'user' }, content: 'keep until token', importance: 2 })
    expect(added.ok).toBe(true)
    const id = added.ok ? added.data.id : ''

    const first = await run('cortex_memory_delete', { id })
    expect(first.ok).toBe(true)

    // A bogus confirm fails but must not invalidate the issued token.
    const bogus = await run('cortex_memory_delete', { id, confirm: 'nope' })
    expect(bogus.ok).toBe(false)

    const real = await run('cortex_memory_delete', { id, confirm: first.token })
    expect(real.ok).toBe(true)
    expect(real.deleted).toBe(true)
  })
})
