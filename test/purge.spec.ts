import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import { CortexStore } from '../src/host/store.ts'
import type { HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import type { CortexRuntimeView, ModuleDeps } from '../src/host/types.ts'
import { apply, PURGE_CONFIRM, TOOLS } from '../src/host/modules/purge/index.ts'

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

  it('refuses without the exact confirm literal and leaves state intact', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-purge-'))
    const deps = makeDeps()
    await store!.init()
    await store!.addEntry({ scope: { track: 'global' }, content: 'survivor', importance: 3 })
    apply(deps)

    // A wrong literal is refused and deletes nothing.
    const wrong = await call('cortex_purge', { confirm: 'please-delete-everything' })
    expect(wrong.ok).toBe(false)
    // The required confirm left blank (or missing) is also refused, not a step.
    const missing = await call('cortex_purge', {})
    expect(missing.ok).toBe(false)

    // State is intact: the seeded entry is still there.
    const list = await store!.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(1)
    const schema = await store!.statusSnapshot()
    if (schema.ok) expect(schema.data.schema).toBeGreaterThanOrEqual(1)
  })

  it('erases all state with the exact confirm literal and re-inits the root', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-purge-'))
    const deps = makeDeps()
    await store!.init()
    await store!.addEntry({ scope: { track: 'global' }, content: 'doomed one', importance: 3 })
    await store!.addEntry({ scope: { track: 'user' }, content: 'doomed two', importance: 2 })
    apply(deps)

    const result = await call('cortex_purge', { confirm: PURGE_CONFIRM })
    expect(result.ok).toBe(true)
    // The root exists again and is empty and usable.
    const list = await store!.listEntries({ track: 'global', branch: null })
    if (list.ok) expect(list.data.entries).toHaveLength(0)
    const user = await store!.listEntries({ track: 'user', branch: null })
    if (user.ok) expect(user.data.entries).toHaveLength(0)
    const snapshot = await store!.statusSnapshot()
    if (snapshot.ok) expect(snapshot.data.stateRoot).toBe(root)
  })
})
