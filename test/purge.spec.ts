import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import { CortexStore } from '../src/host/store.ts'
import type { HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import type { CortexRuntimeView, ModuleDeps } from '../src/host/types.ts'
import { apply, PURGE_CONFIRM, PURGE_TOKEN_KEY, TOOLS } from '../src/host/modules/purge/index.ts'

let root: string | undefined
let store: CortexStore | undefined
const tools = new Map<string, ToolDefinition>()

afterEach(async () => {
  tools.clear()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  store = undefined
})

/** A minimal fake host that records tool registrations (mirrors test/memory/fixture.ts). */
function makeDeps(): ModuleDeps {
  const ctx = {
    tools: {
      register(def: ToolDefinition) {
        if (tools.has(def.name)) throw new Error(`tool "${def.name}" already registered`)
        tools.set(def.name, def)
        return () => {}
      },
    },
    settings: { writable: false, register: () => ({ get: () => ({}) }) } as never,
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    inject: (_services: string[], callback: (context: HostContextShape) => void) => callback(ctx),
    on: () => () => {},
    effect: (callback: () => unknown) => { callback(); return () => {} },
  } as unknown as HostContextShape
  const current = resolveConfig({})
  const view: CortexRuntimeView = { modules: [], errors: [] }
  store = new CortexStore({ root: root as string, caps: () => current.caps })
  return { ctx, cfg: () => current, store: store as CortexStore, log: () => {}, warn: () => {}, runtime: () => view }
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const definition = tools.get(name)
  expect(definition, `tool ${name} must be registered`).toBeDefined()
  return (await definition?.execute(args as never, { signal: new AbortController().signal } as never)) as Record<string, any>
}

describe('cortex_purge', () => {
  it('exposes exactly one tool and registers it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-purge-'))
    apply(makeDeps())
    expect([...TOOLS]).toEqual(['cortex_purge'])
    expect(tools.has('cortex_purge')).toBe(true)
  })

  it('RETIREs the old literal: PURGE_CONFIRM is still exported but refused on step 2', async () => {
    // Contract: the literal is defined so docs/tests can assert it is retired,
    // but the implementation MUST refuse it.
    expect(PURGE_CONFIRM).toBe('PURGE_ALL_CORTEX_STATE')
  })

  it('step 1 (no confirm) returns a token and deletes nothing', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-purge-'))
    const deps = makeDeps()
    await store!.init()
    await store!.addEntry({ scope: { track: 'global' }, content: 'survivor', importance: 3 })
    apply(deps)

    const step1 = await call('cortex_purge', {})
    expect(step1.ok).toBe(true)
    expect(step1.deleted).toBe(false)
    expect(typeof step1.token).toBe('string')
    expect(step1.token).not.toBe('')
    expect(step1.text).toContain('About to permanently delete')
    // State is intact.
    const list = await store!.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(1)
  })

  it('step 2 with the correct token wipes state and re-inits the root', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-purge-'))
    const deps = makeDeps()
    await store!.init()
    await store!.addEntry({ scope: { track: 'global' }, content: 'doomed one', importance: 3 })
    await store!.addEntry({ scope: { track: 'user' }, content: 'doomed two', importance: 2 })
    apply(deps)

    // Get the token via step 1.
    const step1 = await call('cortex_purge', {})
    expect(step1.ok).toBe(true)
    const token = step1.token as string

    // Step 2 with the correct token.
    const step2 = await call('cortex_purge', { confirm: token })
    expect(step2.ok).toBe(true)
    expect(step2.deleted).toBe(true)
    expect(step2.removed).toBe(root)
    expect(step2.reinit).toBe(true)
    // State is gone.
    const list = await store!.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(0)
    const user = await store!.listEntries({ track: 'user', branch: null })
    if (user.ok) expect(user.data.entries).toHaveLength(0)
    const snapshot = await store!.statusSnapshot()
    if (snapshot.ok) expect(snapshot.data.stateRoot).toBe(root)
  })

  it('refuses wrong tokens, the retired literal, and reuse', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-purge-'))
    const deps = makeDeps()
    await store!.init()
    apply(deps)

    // Wrong token → refused.
    const wrong = await call('cortex_purge', { confirm: 'wrong-guess' })
    expect(wrong.ok).toBe(false)
    expect(wrong.error?.message).toContain('not the single-use token')

    // Retired literal → refused (the whole point of D-03).
    const retired = await call('cortex_purge', { confirm: PURGE_CONFIRM })
    expect(retired.ok).toBe(false)
    expect(retired.error?.message).toContain('no longer accepted')

    // Reuse of the same token → refused (single-use).
    const step1 = await call('cortex_purge', {})
    const token = step1.token as string
    const firstWipe = await call('cortex_purge', { confirm: token })
    expect(firstWipe.ok).toBe(true)
    // Token consumed; second use refused.
    const reuse = await call('cortex_purge', { confirm: token })
    expect(reuse.ok).toBe(false)
    expect(reuse.error?.message).toContain('not the single-use token')
  })

  it('refuses missing confirm in step 2 shape (empty string → step 1 again)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-purge-'))
    const deps = makeDeps()
    await store!.init()
    apply(deps)

    // Empty string should trigger step 1, not refuse.
    const empty = await call('cortex_purge', { confirm: '' })
    expect(empty.ok).toBe(true)
    expect(empty.deleted).toBe(false)
    expect(typeof empty.token).toBe('string')
    expect(empty.token).not.toBe('')
  })
})
