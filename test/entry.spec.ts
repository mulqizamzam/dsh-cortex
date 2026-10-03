import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MODULES, apply, cortexRuntime, inject, name, resolveConfig } from '../src/host/index.ts'
import { CortexStore } from '../src/host/store.ts'
import { roomsService } from '../src/host/modules/rooms/index.ts'
import { getTodoService, readEndpoints as todoReadEndpoints } from '../src/host/modules/todo/index.ts'
import { getLogService, readEndpoints as logsReadEndpoints } from '../src/host/modules/logs/index.ts'
import { CORTEX_PING_ENDPOINT, CORTEX_READ_CHANNEL, CORTEX_WRITE_CHANNEL } from '../src/host/rpc-channels.ts'
import type { HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import type { CortexConfig, CortexRuntimeView, ModuleDeps } from '../src/host/types.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

/** Boot-contract tests (P4): apply never throws, modules are isolated, and a
 * failed boot still leaves a status tool that says why. */

interface FakeOptions {
  duplicateTool?: string
  toolsThrows?: boolean
  settingsThrows?: boolean
  injectThrows?: boolean
  noHomeService?: boolean
  /** Host-owned live agent handles (F10: a release must not terminate them). */
  agents?: Array<{ id: string; status?: string }>
}

interface Fake {
  ctx: HostContextShape
  tools: Map<string, ToolDefinition>
  namespaces: string[]
  channels: string[]
  handlers: Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>
  listeners: Map<string, (...args: never[]) => unknown>
  /** Cordis effect disposers for this context, in registration order. */
  effects: Array<{ label?: string; dispose: () => unknown }>
  /** Live registrations per event name (started minus stopped). */
  subscriptions: Map<string, number>
  /** Emulate fiber disposal: unwind every effect, newest first. */
  unload(): void
  homeAsked: string[]
}

function makeFake(options: FakeOptions = {}, home = ''): Fake {
  const tools = new Map<string, ToolDefinition>()
  const namespaces: string[] = []
  const channels: string[] = []
  const handlers = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const homeAsked: string[] = []
  const effects: Array<{ label?: string; dispose: () => unknown }> = []
  const subscriptions = new Map<string, number>()
  const liveAgents = options.agents ?? []
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        if (options.toolsThrows === true) throw new Error('tools service unavailable')
        if (options.duplicateTool === definition.name || tools.has(definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered`)
        }
        tools.set(definition.name, definition)
        return () => {}
      },
      // Mirrors the host registry lookup (ToolRuntime.get) so F6 is exercised.
      get(name: string): ToolDefinition | undefined { return tools.get(name) },
    },
    settings: {
      writable: false,
      register<T>(namespace: string, _schema: unknown, config: { base?: Partial<T> }): { get(): T } {
        if (options.settingsThrows === true) throw new Error(`settings namespace "${namespace}" is already registered`)
        namespaces.push(namespace)
        return { get: () => config.base as T }
      },
    },
    agents: {
      get: (id: string) => liveAgents.find(agent => agent.id === id),
      roots: () => liveAgents,
    },
    get(name2: string): unknown {
      homeAsked.push(name2)
      if (name2 === 'dshHomePath' && options.noHomeService !== true) {
        return (...segments: string[]) => join(home, ...segments)
      }
      return undefined
    },
    inject(services: string[], callback: (context: HostContextShape) => void): void {
      if (options.injectThrows === true) throw new Error('connection service missing')
      if (services.includes('connection')) {
        (ctx as { connection?: unknown }).connection = {
          rpc: {
            handle(channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>): () => void {
              channels.push(channel)
              handlers.set(channel, handler)
              return () => {}
            },
          },
        }
      }
      callback(ctx)
    },
    on: (name2: string, listener: (...args: never[]) => unknown) => {
      listeners.set(name2, listener)
      subscriptions.set(name2, (subscriptions.get(name2) ?? 0) + 1)
      return () => { subscriptions.set(name2, Math.max(0, (subscriptions.get(name2) ?? 1) - 1)) }
    },
    // Cordis semantics: the callback runs NOW and whatever disposer it returns is
    // unwound when the fiber is disposed — which `unload()` below emulates.
    effect: (callback: () => unknown, label?: string) => {
      const dispose = callback()
      effects.push({ label, dispose: typeof dispose === 'function' ? dispose as () => unknown : () => {} })
      return () => {}
    },
  } as unknown as HostContextShape
  return {
    ctx, tools, namespaces, channels, handlers, listeners, homeAsked, effects, subscriptions,
    unload(): void {
      for (const entry of effects.splice(0).reverse()) {
        try {
          entry.dispose()
        } catch {
          // Host-side disposal failures are not the plugin's to propagate (P4).
        }
      }
    },
  }
}

let home = ''
let previousHome: string | undefined
let previousDsh: string | undefined

beforeEach(async () => {
  home = await makeTempRoot('dsh-cortex-entry-')
  previousHome = process.env.HOME
  previousDsh = process.env.DSH_HOME
  process.env.HOME = join(home, 'must-not-be-used')
  delete process.env.DSH_HOME
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousDsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDsh
  await removeTempRoot(home)
})

describe('plugin entry contract', () => {
  it('exports the cordis plugin face and the wired module set', () => {
    expect(name).toBe('dsh-cortex')
    expect(inject).toEqual(['tools', 'settings', 'commands', 'agents', 'subagents'])
    // Parent integration (wave-1 wired): MODULES grew from [status] to the
    // assembled modules; M4 (prompts) is now wired too (B3), and cortex_purge is
    // part of the wired set (honest reclaim-space tool).
    expect(MODULES.map(module => module.name)).toEqual(['status', 'memory', 'todo', 'logs', 'progress', 'rooms', 'sessions', 'delegate', 'purge', 'prompts', 'conflict', 'board', 'decisions'])
  })

  it('boots: registers the cortex namespace, the status tool, and uses the host home service', () => {
    const fake = makeFake({}, home)
    expect(() => apply(fake.ctx, {})).not.toThrow()
    expect(fake.namespaces).toEqual(['cortex'])
    expect(fake.tools.has('cortex_status')).toBe(true)
    expect(fake.homeAsked).toContain('dshHomePath')
    expect(cortexRuntime().modules[0]?.state).toBe('ok')
    expect(cortexRuntime().bootError).toBeUndefined()
  })

  it('the status tool reports modules, effective config and the state root', async () => {
    const fake = makeFake({}, home)
    apply(fake.ctx, { caps: { entryChars: 111 } } as Partial<CortexConfig>)
    const definition = fake.tools.get('cortex_status')
    expect(definition).toBeDefined()
    const value = await definition?.execute({} as never, { signal: new AbortController().signal }) as Record<string, any>
    expect(value.plugin).toBe('dsh-cortex')
    expect(value.stateRoot).toBe(join(home, 'dsh-cortex'))
    expect(value.config.caps.entryChars).toBe(111)
    // P3: an unrelated patch never turns a heavy effect on by accident.
    expect(value.config.delegation.enabled).toBe(false)
    expect(value.config.stateRoot).toBe('(default: <DSH_HOME>/dsh-cortex)')
    expect(value.config.memory.autoAccept).toBe(false)
    expect(value.config.pending).toEqual({})
    expect(value.modules[0].name).toBe('status')
  })

  it('config.stateRoot overrides the home service (DESIGN §2)', async () => {
    const fake = makeFake({}, home)
    apply(fake.ctx, { stateRoot: join(home, 'elsewhere') } as Partial<CortexConfig>)
    const value = await fake.tools.get('cortex_status')?.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
    expect(value.stateRoot).toBe(join(home, 'elsewhere'))
  })

  it('without the home service it falls back to $DSH_HOME / ~/.dsh', async () => {
    const fake = makeFake({ noHomeService: true }, home)
    process.env.DSH_HOME = join(home, 'envhome')
    apply(fake.ctx, {})
    const value = await fake.tools.get('cortex_status')?.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
    expect(value.stateRoot).toBe(join(home, 'envhome', 'dsh-cortex'))
  })

  it('a colliding tool name fails only that module and never escapes apply()', () => {
    const fake = makeFake({ duplicateTool: 'cortex_status' }, home)
    expect(() => apply(fake.ctx, {})).not.toThrow()
    expect(cortexRuntime().modules[0]?.state).toBe('failed')
    expect(cortexRuntime().modules[0]?.error).toContain('already registered')
    expect(cortexRuntime().bootError).toBeUndefined()
    // Wired reality: the collision kills only the STATUS module — every other
    // module still registers its tools (was `tools.size === 0` in the stub era).
    expect(fake.tools.has('cortex_status')).toBe(false)
    expect(fake.tools.size).toBeGreaterThan(20)
    expect(cortexRuntime().modules.filter(item => item.state === 'ok').length).toBeGreaterThanOrEqual(6)
  })

  it('a settings collision degrades to a status-only tool naming the failure', async () => {
    const fake = makeFake({ settingsThrows: true }, home)
    const originalError = console.error
    const seen: string[] = []
    console.error = (...parts: unknown[]) => { seen.push(parts.join(' ')) }
    try {
      expect(() => apply(fake.ctx, {})).not.toThrow()
    } finally {
      console.error = originalError
    }
    expect(fake.tools.has('cortex_status')).toBe(true)
    expect(cortexRuntime().bootError).toContain('already registered')
    expect(seen.join('\n')).toContain('boot failed')
    const value = await fake.tools.get('cortex_status')?.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
    expect(value.state).toBe('failed')
    expect(String(value.error)).toContain('already registered')
  })

  it('a missing tools service cannot break the boot either', () => {
    const fake = makeFake({ toolsThrows: true }, home)
    const originalError = console.error
    console.error = () => {}
    try {
      expect(() => apply(fake.ctx, {})).not.toThrow()
    } finally {
      console.error = originalError
    }
    expect(fake.tools.size).toBe(0)
    expect(cortexRuntime().modules[0]?.state).toBe('failed')
  })

  it('a throwing ctx.inject leaves modules wired and records the transport error', () => {
    const fake = makeFake({ injectThrows: true }, home)
    expect(() => apply(fake.ctx, {})).not.toThrow()
    expect(cortexRuntime().modules[0]?.state).toBe('ok')
    expect((cortexRuntime().errors ?? []).join(' ')).toContain('connection service missing')
  })

  it('mounts the loopback read+write channels when the web transport exists', () => {
    const fake = makeFake({}, home)
    apply(fake.ctx, {})
    // Parent integration: the write channel (human/UI actions, confirm-gated per
    // handler) is mounted beside the read channel, both loopback-authority.
    expect(fake.channels).toEqual([CORTEX_READ_CHANNEL, CORTEX_WRITE_CHANNEL])
    expect(CORTEX_READ_CHANNEL).toMatch(/^\/[A-Za-z0-9._~-]+$/)
    expect(CORTEX_PING_ENDPOINT).toBe('ping')
  })
})

describe('brace safety in model-visible output (host #53)', () => {
  it('a configured stateRoot containing brace pairs is neutralized in tool output', async () => {
    const fake = makeFake({}, home)
    const hostile = join(home, '{{tpl}}')
    apply(fake.ctx, { stateRoot: hostile } as Partial<CortexConfig>)
    const payload = await fake.tools.get('cortex_status')?.execute({} as never, { signal: new AbortController().signal })
    // PARENT FIX (takeover): assert on STRING LEAVES. JSON.stringify legitimately
    // emits adjacent '}}' when nested objects close (`"retention":{...}}`) — that is
    // syntax, not model-visible text; '{{' cannot arise from syntax but '}}' can.
    const leaves = (value: unknown): string[] => typeof value === 'string' ? [value]
      : Array.isArray(value) ? value.flatMap(leaves)
        : value !== null && typeof value === 'object' ? Object.values(value as Record<string, unknown>).flatMap(leaves) : []
    const texts = leaves(payload)
    expect(texts.length).toBeGreaterThan(3)
    for (const text of texts) {
      expect(text).not.toContain('{{')
      expect(text).not.toContain('}}')
    }
    expect(JSON.stringify(payload)).toContain('{ {tpl} }')
  })

  it('a boot error whose text carries braces is neutralized too', async () => {
    const fake = makeFake({ settingsThrows: true, duplicateTool: undefined }, home)
    const originalError = console.error
    console.error = () => {}
    try {
      apply(fake.ctx, { stateRoot: join(home, '{{deep}}') } as Partial<CortexConfig>)
    } finally {
      console.error = originalError
    }
    // settings threw => degraded path; its only tool must still be brace-safe.
    const value = JSON.stringify(await fake.tools.get('cortex_status')?.execute({} as never, { signal: new AbortController().signal }))
    expect(value).not.toContain('{{')
    expect(value).not.toContain('}}')
  })

  it('tool and parameter descriptions are brace-free by construction', () => {
    const fake = makeFake({}, home)
    apply(fake.ctx, {})
    // PARENT FIX (takeover): check TEXT CONTENT only. JSON.stringify of any
    // `"properties": {}` yields the adjacent closing braces of JSON SYNTAX
    // (`:{}}`), which is not a model-visible brace pair — the host interpolates
    // template pairs in description/param STRINGS, never in JSON structure.
    const stringsOf = (value: unknown): string[] => typeof value === 'string' ? [value]
      : Array.isArray(value) ? value.flatMap(stringsOf)
        : value !== null && typeof value === 'object' ? Object.values(value as Record<string, unknown>).flatMap(stringsOf) : []
    for (const definition of fake.tools.values()) {
      expect(definition.description.includes('{{') || definition.description.includes('}}')).toBe(false)
      for (const text of stringsOf(definition.parameters).concat(stringsOf(definition.description))) {
        expect(text.includes('{{') || text.includes('}}')).toBe(false)
      }
    }
  })
})

/** B3 + B4 (Phase 1 follow-up): the prompts module is registered, and
 * `pending.approve` routes each supported kind to the module that owns it. */
describe('prompts wiring and by-kind approval (B3/B4)', () => {
  const stateRoot = (): string => join(home, 'state')

  async function bootWithStore(): Promise<{ fake: Fake; store: CortexStore }> {
    const fake = makeFake({}, home)
    apply(fake.ctx, { stateRoot: stateRoot() } as Partial<CortexConfig>)
    const store = new CortexStore({ root: stateRoot() })
    expect((await store.init()).ok).toBe(true)
    return { fake, store }
  }

  function channel(fake: Fake, name2: string): (endpoint: string, payload: unknown) => Promise<unknown> {
    const handler = fake.handlers.get(name2)
    if (handler === undefined) throw new Error(`${name2} not mounted`)
    return handler
  }

  it('registers the prompts tools and endpoints (B3)', async () => {
    const { fake } = await bootWithStore()
    for (const tool of ['cortex_prompt_list', 'cortex_prompt_get', 'cortex_prompt_save', 'cortex_pending_list', 'cortex_pending_reject', 'cortex_prompt_delete', 'cortex_prompt_toggle', 'cortex_prompt_inject']) {
      expect(fake.tools.has(tool), tool).toBe(true)
    }
    const listed = await channel(fake, CORTEX_READ_CHANNEL)('prompts.list', {}) as { ok: boolean }
    expect(listed.ok).toBe(true)
  })

  it('routes kind=prompt to the prompt approver (B4)', async () => {
    const { fake, store } = await bootWithStore()
    const row = await store.addPending({ kind: 'prompt', proposal: { title: 'Review', body: 'walk the diff' } })
    if (!row.ok) throw new Error(row.error)
    const result = await channel(fake, CORTEX_WRITE_CHANNEL)('pending.approve', { id: row.data.id }) as { ok: boolean; value?: { pendingId?: string } }
    expect(result.ok).toBe(true)
    expect(result.value?.pendingId).toBe(row.data.id)
    expect((await store.listPrompts()).data?.map(doc => doc.title)).toEqual(['Review'])
    expect((await store.listPending({ status: 'approved' })).data?.map(item => item.id)).toEqual([row.data.id])
  })

  it('keeps kind=memory on the memory approver (regression)', async () => {
    const { fake, store } = await bootWithStore()
    const row = await store.addPending({ kind: 'memory', proposal: { track: 'global', content: 'a durable fact' } })
    if (!row.ok) throw new Error(row.error)
    const result = await channel(fake, CORTEX_WRITE_CHANNEL)('pending.approve', { id: row.data.id }) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect((await store.listEntries({ track: 'global' })).data?.entries.map(entry => entry.content)).toEqual(['a durable fact'])
  })

  it('still rejects a kind with no approver', async () => {
    const { fake, store } = await bootWithStore()
    const row = await store.addPending({ kind: 'todo', proposal: { text: 'ship it' } })
    if (!row.ok) throw new Error(row.error)
    const result = await channel(fake, CORTEX_WRITE_CHANNEL)('pending.approve', { id: row.data.id }) as { ok: boolean; error?: { code?: string; message?: string } }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('command-error') // projected; ours survives in the message
    expect(result.error?.message).toContain('[unsupported-kind]')
    expect((await store.listPending({ status: 'pending' })).data?.map(item => item.id)).toEqual([row.data.id])
  })

  it('cannot approve a prompt when the state root is newer-schema read-only', async () => {
    await mkdir(stateRoot(), { recursive: true })
    const store = new CortexStore({ root: stateRoot() })
    await store.init()
    const row = await store.addPending({ kind: 'prompt', proposal: { title: 'T', body: 'B' } })
    if (!row.ok) throw new Error(row.error)
    await writeFile(join(stateRoot(), 'schema.json'), '{"version":2}', 'utf8')
    const fake = makeFake({}, home)
    apply(fake.ctx, { stateRoot: stateRoot() } as Partial<CortexConfig>)
    const result = await channel(fake, CORTEX_WRITE_CHANNEL)('pending.approve', { id: row.data.id }) as { ok: boolean; error?: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error?.message ?? '').toContain('read-only')
    expect((await store.listPrompts()).data).toEqual([])
  })
})

/** F5 + F6 (Phase 1 audit): a module that fails after partial setup publishes no
 * endpoint, and status reports the tools the registry actually holds. */
describe('failed-module endpoints and status tool accuracy (F5/F6)', () => {
  function channel(fake: Fake, name2: string): (endpoint: string, payload: unknown) => Promise<unknown> {
    const handler = fake.handlers.get(name2)
    if (handler === undefined) throw new Error(`${name2} not mounted`)
    return handler
  }

  async function statusPayload(fake: Fake): Promise<Record<string, unknown>> {
    const tool = fake.tools.get('cortex_status')
    if (tool === undefined) throw new Error('cortex_status not registered')
    return await tool.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
  }

  const modulesOf = (payload: Record<string, unknown>) => payload.modules as Array<{ name: string; state: string; tools: string[] }>

  it('a module that throws after binding publishes no endpoint (F5)', async () => {
    // delegate/index.ts binds its endpoint maps at :44 and only then throws at
    // :63 when its core tool is refused — the exact partial-setup case.
    const fake = makeFake({ duplicateTool: 'cortex_delegate' }, home)
    apply(fake.ctx, { stateRoot: join(home, 'state') } as Partial<CortexConfig>)
    const refused = await channel(fake, CORTEX_READ_CHANNEL)('jobs.list', {}) as { ok: boolean; error?: { code?: string; message?: string } }
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe('command-error') // projected; ours survives in the message
    expect(refused.error?.message).toContain('[unknown-endpoint]')
    // Failure isolation unchanged: an unrelated module still answers.
    const unrelated = await channel(fake, CORTEX_READ_CHANNEL)('todo.list', {}) as { ok: boolean }
    expect(unrelated.ok).toBe(true)
    // cortex_status reflects the failure.
    const modules = modulesOf(await statusPayload(fake))
    expect(modules.find(module => module.name === 'delegate')?.state).toBe('failed')
    expect(modules.find(module => module.name === 'todo')?.state).toBe('ok')
  })

  it('status lists the tools actually mounted (F6)', async () => {
    const fake = makeFake({}, home)
    apply(fake.ctx, { stateRoot: join(home, 'state') } as Partial<CortexConfig>)
    const modules = modulesOf(await statusPayload(fake))
    expect(modules.find(module => module.name === 'status')?.tools).toEqual(['cortex_status'])
    expect(modules.find(module => module.name === 'todo')?.tools).toHaveLength(4)
    expect(modules.find(module => module.name === 'prompts')?.tools).toHaveLength(8)
    for (const module of modules) {
      for (const tool of module.tools) expect(fake.tools.has(tool), tool).toBe(true)
    }
  })

  it('a refused tool registration is not reported as healthy (F6)', async () => {
    const fake = makeFake({ duplicateTool: 'cortex_status' }, home)
    apply(fake.ctx, { stateRoot: join(home, 'state') } as Partial<CortexConfig>)
    const statusModule = cortexRuntime().modules.find(module => module.name === 'status')
    expect(statusModule?.state).toBe('failed')
    expect(statusModule?.tools).toEqual([])
    expect(fake.tools.has('cortex_status')).toBe(false)
  })
})

/** F7 (Phase 1 audit): a duplicate endpoint keeps first-writer precedence AND is
 * visible through `cortex_status`, not only through the log. */
describe('duplicate endpoint conflicts are observable (F7)', () => {
  // `MODULES` is the boot list; a temporary probe module at the end collides with
  // an already-published name without touching production wiring.
  const withProbe = (probe: unknown): (() => void) => {
    MODULES.push(probe as never)
    return () => { MODULES.pop() }
  }
  const probeModule = (endpoints: Record<string, unknown>, name2 = 'probe') => ({
    name: name2,
    TOOLS: [] as string[],
    apply: () => {},
    ...endpoints,
  })
  const wiringErrors = (_fake: Fake): string[] => cortexRuntime().errors ?? []
  const statusOf = async (fake: Fake): Promise<Record<string, unknown>> => {
    const tool = fake.tools.get('cortex_status')
    if (tool === undefined) throw new Error('cortex_status not registered')
    return await tool.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
  }

  it('a duplicate READ endpoint keeps the first writer and records the conflict', async () => {
    const fake = makeFake({}, home)
    const restore = withProbe(probeModule({ readEndpoints: { 'todo.list': async () => ({ ok: true, value: { stolen: true } }) } }))
    try {
      apply(fake.ctx, { stateRoot: join(home, 'state') } as Partial<CortexConfig>)
      const handler = fake.handlers.get(CORTEX_READ_CHANNEL)
      const answer = await handler?.('todo.list', {}) as { ok: boolean; value?: Record<string, unknown> }
      expect(answer.ok).toBe(true)
      expect(answer.value).not.toHaveProperty('stolen') // the winner is still todo's handler
      expect(wiringErrors(fake).join(' | ')).toContain("endpoint conflict: READ 'todo.list' from 'probe' ignored, kept 'todo'")
      const payload = await statusOf(fake)
      expect((payload.wiringErrors as string[]).join(' | ')).toContain("endpoint conflict: READ 'todo.list'")
    } finally {
      restore()
    }
  })

  it('a duplicate WRITE endpoint keeps the first writer and records the conflict', async () => {
    const fake = makeFake({}, home)
    const restore = withProbe(probeModule({ writeEndpoints: { 'todo.add': async () => ({ ok: true, value: { stolen: true } }) } }))
    try {
      apply(fake.ctx, { stateRoot: join(home, 'state') } as Partial<CortexConfig>)
      expect(wiringErrors(fake).join(' | ')).toContain("endpoint conflict: WRITE 'todo.add' from 'probe' ignored, kept 'todo'")
      const handler = fake.handlers.get(CORTEX_WRITE_CHANNEL)
      const answer = await handler?.('todo.add', { text: 'x', track: 'daily' }) as { ok: boolean; value?: Record<string, unknown> }
      expect(answer.value ?? {}).not.toHaveProperty('stolen')
    } finally {
      restore()
    }
  })

  it('a clean boot reports no endpoint conflict', async () => {
    const fake = makeFake({}, home)
    apply(fake.ctx, { stateRoot: join(home, 'state') } as Partial<CortexConfig>)
    expect(wiringErrors(fake).filter(entry => entry.includes('endpoint conflict'))).toEqual([])
    const handler = fake.handlers.get(CORTEX_READ_CHANNEL)
    expect((await handler?.('todo.list', {}) as { ok: boolean }).ok).toBe(true)
  })
})

/** F8 (Phase 1 audit): live config updates must not leave a second, silently
 * divergent authoritative config — mutable fields follow, stateRoot is pinned. */
describe('live config update consistency (F8)', () => {
  function bootF8(): Fake {
    const fake = makeFake({}, home)
    apply(fake.ctx, { stateRoot: join(home, 'state') } as Partial<CortexConfig>)
    return fake
  }
  const pushConfig = (fake: Fake, next: Record<string, unknown>): void => {
    const listener = fake.listeners.get('settings/updated')
    if (listener === undefined) throw new Error('settings/updated listener not registered')
    ;(listener as unknown as (namespace: string, value: unknown) => void)('cortex', next)
  }
  const statusOf = async (fake: Fake): Promise<Record<string, unknown>> => {
    const tool = fake.tools.get('cortex_status')
    if (tool === undefined) throw new Error('cortex_status not registered')
    return await tool.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
  }

  it('a valid live update changes the fields meant to be live', async () => {
    const fake = bootF8()
    pushConfig(fake, { stateRoot: join(home, 'state'), inject: { enabled: false } })
    const payload = await statusOf(fake)
    expect((payload.config as Record<string, unknown>).inject).toMatchObject({ enabled: false })
    const ping = await fake.handlers.get(CORTEX_READ_CHANNEL)?.('ping', {}) as { ok: boolean; value?: { injectEnabled: boolean } }
    expect(ping.value?.injectEnabled).toBe(false)
  })

  it('a stateRoot change is ignored deterministically and never silently applied', async () => {
    const fake = bootF8()
    const activeRoot = cortexRuntime().modules.length > 0 ? join(home, 'state') : ''
    pushConfig(fake, { stateRoot: join(home, 'elsewhere') })
    const errors = (cortexRuntime().errors ?? []).join(' | ')
    expect(errors).toContain('stateRoot change')
    expect(errors).toContain('immutable after boot')
    // The reported config root is the ACTIVE root, never the ignored one.
    const payload = await statusOf(fake)
    const config = payload.config as Record<string, unknown>
    expect(config.stateRoot).toBe(activeRoot)
    const ping = await fake.handlers.get(CORTEX_READ_CHANNEL)?.('ping', {}) as { value?: { stateRoot: string } }
    expect(ping.value?.stateRoot).toBe(activeRoot)
  })

  it('an unusable patch is coerced by the real schema mechanism, not reported as a failed swap', async () => {
    const fake = bootF8()
    pushConfig(fake, { stateRoot: join(home, 'state'), caps: 'nonsense', inject: 42, delegation: { maxConcurrent: -5 } })
    expect((cortexRuntime().errors ?? []).filter(entry => entry.includes('config'))).toEqual([])
    const payload = await statusOf(fake)
    const caps = (payload.config as Record<string, unknown>).caps as Record<string, number>
    expect(caps.entryChars).toBe(400)          // garbage falls back to the shipped default
    expect(caps.stateQuotaBytes).toBe(67108864)
    // Final resolved values, not just "no error" (config.ts:129-133 coerces a
    // non-object `inject` back to the shipped defaults on every key).
    expect((payload.config as Record<string, unknown>).inject).toEqual({ enabled: true, user: true, global: true, project: true, todo: true })
  })
})

/** F9 (Phase 1 audit): `store.init()` is fire-and-forget, so its outcome can
 * settle after the boot that started it was replaced. The failure must reach the
 * diagnostics that are read NOW, and must never be written into an array nothing
 * reads any more. Only observable runtime state is asserted here. */
describe('async init diagnostics follow the live boot (F9)', () => {
  const SUPERSEDED = 'state (superseded boot): '

  /** Bounded poll: the scaffold does real filesystem work, so settlement is
   *  awaited on an observable condition, never on a fixed sleep. */
  const waitFor = async (condition: () => boolean): Promise<boolean> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (condition()) return true
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return condition()
  }
  /** Settlement detector for an outcome that only becomes observable once every
   *  in-flight scaffold has landed: the active diagnostics stop changing. */
  const settle = async (read: () => string): Promise<void> => {
    let previous = read()
    for (let stable = 0, attempt = 0; attempt < 400 && stable < 10; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      const current = read()
      stable = current === previous ? stable + 1 : 0
      previous = current
    }
  }
  /** A root whose parent is a FILE: the scaffold's `mkdir -p` fails with ENOTDIR,
   *  so `init()` resolves `{ok:false}` — the reachable failure branch. */
  const blockedRoot = async (label: string): Promise<string> => {
    const blocker = join(home, `${label}.txt`)
    await writeFile(blocker, 'not a directory')
    return join(blocker, 'state')
  }
  const bootAt = (root: string): Fake => {
    const fake = makeFake({}, home)
    apply(fake.ctx, { stateRoot: root } as Partial<CortexConfig>)
    return fake
  }
  const errorsOf = (view: CortexRuntimeView): string[] => view.errors ?? []
  const statusOf = async (fake: Fake): Promise<Record<string, unknown>> => {
    const tool = fake.tools.get('cortex_status')
    if (tool === undefined) throw new Error('cortex_status not registered')
    return await tool.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
  }

  it('a failed state scaffold is non-fatal and reaches the active diagnostics', async () => {
    const root = await blockedRoot('blocker-single')
    const fake = bootAt(root)
    // Non-fatal: the boot returned, no degraded boot-error view, modules wired.
    expect(cortexRuntime().bootError).toBeUndefined()
    expect(cortexRuntime().modules).toHaveLength(MODULES.length)
    expect(cortexRuntime().modules.filter(module => module.state === 'failed')).toEqual([])
    expect(await waitFor(() => errorsOf(cortexRuntime()).some(entry => entry.startsWith('state: ')))).toBe(true)
    const reported = errorsOf(cortexRuntime()).filter(entry => entry.startsWith('state: ')).join(' | ')
    expect(reported).toContain('ENOTDIR')
    expect(reported).toContain(root)
    // The channel the operator reads.
    const payload = await statusOf(fake)
    expect((payload.wiringErrors as string[]).join(' | ')).toContain('state: ENOTDIR')
  })

  it('a failure settling after a reload is reported by the ACTIVE runtime, not the retired one', async () => {
    const staleRoot = await blockedRoot('blocker-stale')
    const liveRoot = await blockedRoot('blocker-live')
    bootAt(staleRoot)
    const retired = cortexRuntime()
    // Same synchronous turn as the first boot: its scaffold cannot have settled
    // yet, so the outcome is genuinely delayed past the replacement.
    bootAt(liveRoot)
    const live = cortexRuntime()
    expect(live).not.toBe(retired)
    const inherited = (): string => errorsOf(live).find(entry => entry.startsWith(SUPERSEDED)) ?? ''
    expect(await waitFor(() => inherited() !== '' && errorsOf(live).some(entry => entry.startsWith('state: ')))).toBe(true)
    // The retired runtime was not written: nothing was left in a view no reader
    // can reach, and the live boot's own outcome is intact next to it.
    expect(errorsOf(retired)).toEqual([])
    expect(inherited()).toContain(staleRoot)
    expect(errorsOf(live).filter(entry => entry.startsWith('state: ')).join(' ')).toContain(liveRoot)
  })

  it('a healthy scaffold adds no state line to the active diagnostics', async () => {
    const root = join(home, 'state')
    bootAt(root)
    // Proof the fire-and-forget scaffold really settled: it writes the marker.
    expect(await waitFor(() => existsSync(join(root, 'schema.json')))).toBe(true)
    expect(errorsOf(cortexRuntime()).filter(entry => entry.includes(root))).toEqual([])
  })

  it('repeated load/unload keeps one labelled notice and writes into no retired runtime', async () => {
    const first = await blockedRoot('churn-a')
    const second = await blockedRoot('churn-b')
    const third = await blockedRoot('churn-c')
    const retired: CortexRuntimeView[] = []
    bootAt(first)
    retired.push(cortexRuntime())
    bootAt(second)
    retired.push(cortexRuntime())
    bootAt(third)
    const live = cortexRuntime()
    await settle(() => JSON.stringify(errorsOf(live)))
    // Bounded: this boot's own failure plus at most one inherited notice, however
    // many boots came and went.
    expect(errorsOf(live).filter(entry => entry.includes(third))).toHaveLength(1)
    expect(errorsOf(live).filter(entry => entry.startsWith(SUPERSEDED))).toHaveLength(1)
    expect(errorsOf(live)).toHaveLength(2)
    for (const view of retired) expect(errorsOf(view)).toEqual([])
  })
})

/** F10 (Phase 1 audit): module-scope caches and service instances outlive the
 * plugin's own fiber. The host's native `ctx.effect` ownership is what releases
 * them, and the fake mirrors that contract: `unload()` unwinds every registered
 * disposer, newest first. State is asserted through the public module faces —
 * `getTodoService`/`getLogService`, the exported endpoint maps, `roomsService`
 * and the store on disk — never through private fields. */
describe('module lifecycle release follows the plugin fiber (F10)', () => {
  const boot = (fake: Fake, root: string): void => {
    apply(fake.ctx, { stateRoot: root } as Partial<CortexConfig>)
  }
  const depsFor = (fake: Fake, root: string): ModuleDeps => ({
    ctx: fake.ctx,
    cfg: () => resolveConfig({ stateRoot: root }),
    store: new CortexStore({ root }),
    log: () => {},
    warn: () => {},
    runtime: () => cortexRuntime(),
  })
  const live = (fake: Fake, event: string): number => fake.subscriptions.get(event) ?? 0
  // `not-wired` is OUR code; the host may only carry `internal`, and ours
  // rides in the message. See src/host/rpc-error.ts.
  const notWired = (answer: unknown): boolean =>
    typeof answer === 'object' && answer !== null
    && (answer as { error?: { code?: string; message?: string } }).error?.code === 'internal'
    && (answer as { error?: { message?: string } }).error?.message?.includes('[not-wired]') === true

  it('a reload releases the todo service instead of inheriting it', async () => {
    const root = join(home, 'state')
    const first = makeFake({}, home)
    boot(first, root)
    const svcA = getTodoService()
    expect(svcA).not.toBeNull()
    // Two modules listen on this event (todo warms its digest, prompts primes its
    // queue); the point is that a reload returns to the SAME number, not to four.
    expect(live(first, 'agent/created')).toBe(2)

    first.unload()

    // Every listener is gone and the module face says so, instead of serving on.
    expect(live(first, 'agent/created')).toBe(0)
    expect(getTodoService()).toBeNull()
    const handler = todoReadEndpoints['todo.list'] as unknown as (payload: unknown) => Promise<unknown>
    expect(notWired(await handler({}))).toBe(true)

    const second = makeFake({}, home)
    boot(second, root)
    expect(getTodoService()).not.toBe(svcA)
    expect(live(second, 'agent/created')).toBe(2)
  })

  it('a reload releases the logs service instead of inheriting it', async () => {
    const root = join(home, 'state')
    const first = makeFake({}, home)
    boot(first, root)
    const svcA = getLogService()
    expect(svcA).not.toBeNull()
    expect(live(first, 'session/event')).toBe(1)

    first.unload()

    expect(live(first, 'session/event')).toBe(0)
    expect(getLogService()).toBeNull()
    const handler = logsReadEndpoints['logs.read'] as unknown as (payload: unknown) => Promise<unknown>
    expect(notWired(await handler({ scope: 'daily' }))).toBe(true)

    const second = makeFake({}, home)
    boot(second, root)
    expect(getLogService()).not.toBe(svcA)
    expect(live(second, 'session/event')).toBe(1)
  })

  it('a reload gets no stale room instance, queue or captured deps', async () => {
    const root = join(home, 'state')
    const first = makeFake({}, home)
    boot(first, root)
    const svcA = roomsService(depsFor(first, root))
    // Module state exists and is in use: this session's ledger was primed, and a
    // room was created through the live service.
    expect(svcA.needsPrime('session-a')).toBe(true)
    await svcA.prime('session-a')
    expect(svcA.needsPrime('session-a')).toBe(false)
    const created = await svcA.create({ title: 'f10 room' })
    expect(created.ok).toBe(true)

    first.unload()

    const second = makeFake({}, home)
    boot(second, root)
    const svcB = roomsService(depsFor(second, root))
    // Pre-fix the SAME instance came back: same queue, same primed marks, and
    // `deps` still pointing at the superseded boot's store/config/context.
    expect(svcB).not.toBe(svcA)
    expect(svcB.needsPrime('session-a')).toBe(true)
    expect(svcB.take('session-a').mails).toEqual([])
    // The durable record is not ours to drop: it outlives the instance.
    expect((await svcB.list()).map(room => room.id)).toContain(created.room?.id)
    expect(existsSync(join(root, 'rooms'))).toBe(true)
  })

  it('the per-root cache is shared inside one boot, so only the release keeps it out of the next', () => {
    const root = join(home, 'state')
    const fake = makeFake({}, home)
    boot(fake, root)
    const svcA = roomsService(depsFor(fake, root))
    // Deliberate sharing inside one boot (tools, endpoints and the seam must see
    // ONE queue). Pre-fix the same instance also survived into the NEXT boot,
    // because nothing ever released it — `resetRoomsService` had no call site.
    expect(roomsService(depsFor(fake, root))).toBe(svcA)
    fake.unload()
    expect(roomsService(depsFor(fake, root))).not.toBe(svcA)
  })

  it('a release never terminates host-owned agent handles', async () => {
    const root = join(home, 'state')
    const agent = { id: 'agent-keep', status: 'idle' }
    const first = makeFake({ agents: [agent] }, home)
    boot(first, root)
    expect(roomsService(depsFor(first, root)).liveAgents().map(entry => entry.id)).toEqual(['agent-keep'])

    first.unload()

    // Nothing in the release path touches the host's own handle registry.
    expect(first.ctx.agents.roots().map(entry => entry.id)).toEqual(['agent-keep'])
    const second = makeFake({ agents: [agent] }, home)
    boot(second, root)
    expect(roomsService(depsFor(second, root)).liveAgents().map(entry => entry.id)).toEqual(['agent-keep'])
  })
})
