import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { neutralizeDeep } from '../src/lib/sanitize.ts'
import { resolveConfig } from '../src/host/config.ts'
import { CortexStore } from '../src/host/store.ts'
import * as statusModule from '../src/host/modules/status/index.ts'
import { apply, cortexRuntime } from '../src/host/index.ts'
import type { HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import type { CortexRuntimeView, ModuleDeps, ModuleStatus } from '../src/host/types.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

/**
 * Serialization-contract tests for `cortex_status`.
 *
 * The host snapshots every tool return value through `snapshotJsonValue()`
 * before it becomes a durable result, and a value carrying `undefined` is
 * rejected there as `value is not lossless JSON`
 * (host `packages/core/tools/src/index.ts:548`). `cortex_status` used to put
 * exactly that into every healthy module row (`error: undefined`), so the tool
 * failed on every healthy boot. These tests pin the invariant at that boundary:
 * the host's own predicate when the harness checkout is reachable, and a
 * portable JSON-plainness walk of the same payload when it is not.
 *
 * 2026-10-09: the predicate moved out of `packages/core/session/src/json.ts`
 * into `packages/util/values/src/index.ts` (host `refactor(values): make shared
 * primitives duplicate-install safe`), so the candidates point there.
 */

/** Host checkout locations, nearest sibling first; absent = boundary checks skip. */
const HOST_JSON_CANDIDATES = [
  '../../../../deepseek-harness/packages/util/values/src/index.ts',
  '/home/administrator/deepseek-harness/packages/util/values/src/index.ts',
].map(location => fileURLToPath(new URL(location, import.meta.url)))
let hostSnapshot: ((value: unknown) => unknown) | null = null

beforeAll(async () => {
  for (const candidate of HOST_JSON_CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      const loaded = await import(candidate) as { snapshotJsonValue?: (value: unknown) => unknown }
      if (typeof loaded.snapshotJsonValue === 'function') { hostSnapshot = loaded.snapshotJsonValue; return }
    } catch { /* this candidate is unreachable from the test runner; try the next */ }
  }
  hostSnapshot = null
})

/** Any value the host would refuse: undefined, non-finite, -0, non-JSON types. */
function nonJsonLeaves(value: unknown, path = '$', found: string[] = []): string[] {
  if (value === undefined) { found.push(`${path}=undefined`); return found }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return found
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) found.push(`${path}=${String(value)}`)
    return found
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => nonJsonLeaves(item, `${path}[${index}]`, found))
    return found
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) nonJsonLeaves(record[key as string], `${path}.${String(key)}`, found)
    return found
  }
  found.push(`${path}=${typeof value}`)
  return found
}

function fakeContext(): { ctx: HostContextShape; tools: Map<string, ToolDefinition> } {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    agents: { get: () => undefined, roots: () => [] },
    get: (name: string) => (name === 'systemPrompt' ? { context: () => () => {} } : undefined),
    inject: (_services: string[], callback: (context: HostContextShape) => void) => { callback(ctx) },
    on: () => () => {},
    effect: () => () => {},
  } as unknown as HostContextShape
  return { ctx, tools }
}

/** The status module alone, so the reported module list is under test control. */
async function executeStatus(modules: readonly ModuleStatus[], root: string): Promise<Record<string, unknown>> {
  const { ctx, tools } = fakeContext()
  const config = resolveConfig({})
  const store = new CortexStore({ root, caps: () => config.caps, warn: () => {} })
  const runtime = (): CortexRuntimeView => ({ modules, errors: [] })
  statusModule.apply({ ctx, cfg: () => config, store, log: () => {}, warn: () => {}, runtime } as unknown as ModuleDeps)
  const definition = tools.get('cortex_status')
  expect(definition).toBeDefined()
  return await definition!.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
}

const HEALTHY: ModuleStatus[] = [{ name: 'status', state: 'ok', tools: ['cortex_status'] }]
const BROKEN: ModuleStatus[] = [{ name: 'memory', state: 'failed', error: 'boom {{x}}', tools: ['cortex_memory_remember'] }]

describe('cortex_status output crosses the host lossless-JSON boundary', () => {
  let root = ''
  beforeEach(async () => { root = await makeTempRoot('dsh-cortex-status-') })
  afterEach(async () => { await removeTempRoot(root) })

  it('has the REAL host lossless-JSON predicate loaded (never skip silently)', () => {
    expect(hostSnapshot, `host snapshotJsonValue not reachable from ${HOST_JSON_CANDIDATES.join(' or ')}`).toBeTypeOf('function')
  })

  it('accepts a payload whose healthy module carries no error', async () => {
    const value = await executeStatus(HEALTHY, root)
    expect(nonJsonLeaves(value)).toEqual([])
    if (hostSnapshot === null) return
    expect(hostSnapshot(value)).not.toBeUndefined()
  })

  it('keeps a failed module error present and brace-neutralized', async () => {
    const value = await executeStatus(BROKEN, root)
    const modules = value.modules as Record<string, unknown>[]
    expect(modules[0]?.error).toBe('boom { {x} }')
    expect(nonJsonLeaves(value)).toEqual([])
    if (hostSnapshot === null) return
    expect(hostSnapshot(value)).not.toBeUndefined()
  })

  it('pins the committed shape: error key always present, null when healthy', async () => {
    const value = await executeStatus([...HEALTHY, ...BROKEN], root)
    const modules = value.modules as Record<string, unknown>[]
    expect(Object.hasOwn(modules[0] as object, 'error')).toBe(true)
    expect(modules[0]?.error).toBeNull()
    expect(typeof modules[1]?.error).toBe('string')
    expect(nonJsonLeaves(value)).toEqual([])
  })

  it('accepts the all-modules-healthy payload a real boot produces', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, { stateRoot: root })
    const modules = cortexRuntime().modules
    expect(modules.length).toBeGreaterThan(1)
    expect(modules.every(module => module.state === 'ok')).toBe(true)
    const value = await tools.get('cortex_status')!.execute({} as never, { signal: new AbortController().signal })
    expect(nonJsonLeaves(value)).toEqual([])
    if (hostSnapshot === null) return
    expect(hostSnapshot(value)).not.toBeUndefined()
  })

  it('accepts the control payload where every module failed', async () => {
    const value = await executeStatus([...BROKEN, { name: 'todo', state: 'failed', error: 'nope', tools: [] }], root)
    expect(nonJsonLeaves(value)).toEqual([])
    if (hostSnapshot === null) return
    expect(hostSnapshot(value)).not.toBeUndefined()
  })

  it('renders the fixed payload into one valid text block', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, { stateRoot: root })
    const definition = tools.get('cortex_status')!
    const value = await definition.execute({} as never, { signal: new AbortController().signal })
    const blocks = definition.output.render({} as never, value as never)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(nonJsonLeaves(blocks)).toEqual([])
    if (hostSnapshot === null) return
    expect(hostSnapshot(blocks)).not.toBeUndefined()
  })

  it('neutralizeDeep keeps every leaf JSON-plain once undefined is gone', () => {
    const payload = neutralizeDeep({ modules: [{ name: 'a', state: 'ok', tools: [], error: null }], nested: { list: ['{{x}}'] } })
    expect(nonJsonLeaves(payload)).toEqual([])
    expect((payload as { nested: { list: string[] } }).nested.list[0]).toBe('{ {x} }')
  })
})
