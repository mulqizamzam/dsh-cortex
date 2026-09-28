/**
 * Test plumbing for the rooms + sessions modules: a hand-built host context bag
 * in the same spirit as `test/entry.spec.ts` (it implements `roots()` / `get()`
 * and OPTIONALLY `create()`), plus a REAL `CortexStore` over a tmp dir, because
 * the seq / consumed-ledger behaviour under test is the on-disk one.
 *
 * Nothing here touches $DSH_HOME: every root comes from `mkdtemp(os.tmpdir())`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import { resetRoomsService, roomsService } from '../../src/host/modules/rooms/service.ts'
import type { RoomService } from '../../src/host/modules/rooms/service.ts'
import type { HostAgent, HostContextShape, HostUserMessage, ToolDefinition } from '../../src/host/dsh.ts'
import type { CortexConfig, ModuleDeps, ResolvedConfig } from '../../src/host/types.ts'

/** A fake agent records every message the module pushes at it. */
export interface FakeAgent extends HostAgent {
  received: Array<{ method: 'followup' | 'steer' | 'inject'; message: HostUserMessage }>
  /** Concatenated text of one received message ('' when there is none). */
  textOf(index?: number): string
}

export interface FakeAgentOptions {
  status?: 'idle' | 'running'
  provider?: string
  model?: string
  cwd?: string
  /** Throw instead of accepting delivery (a hostile / misbehaving host). */
  throwOn?: 'followup' | 'steer' | 'inject'
  /** Delete a method: proves the module feature-detects it before calling. */
  without?: 'followup' | 'steer' | 'inject'
}

export function makeFakeAgent(id: string, options: FakeAgentOptions = {}): FakeAgent {
  const received: FakeAgent['received'] = []
  const push = (method: FakeAgent['received'][number]['method']) => (message: HostUserMessage): void => {
    if (options.throwOn === method) throw new Error(`host ${method}() refused the message`)
    received.push({ method, message })
  }
  const agent = {
    id,
    status: options.status ?? 'idle',
    options: {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    session: { header: { ...(options.cwd === undefined ? {} : { cwd: options.cwd }) } },
    ctx: { on: () => () => {}, effect: (run: () => unknown) => { run(); return () => {} } },
    received,
    followup: push('followup'),
    steer: push('steer'),
    inject: push('inject'),
    textOf: (index = 0): string => {
      const entry = received[index]
      if (entry === undefined) return ''
      return entry.message.content.map(block => block.text ?? '').join('')
    },
  } as unknown as FakeAgent
  if (options.without !== undefined) delete (agent as unknown as Record<string, unknown>)[options.without]
  return agent
}

export interface FakeOptions {
  agents?: FakeAgent[]
  /** Give `agents.create` (absent = the host has no factory: spawn must refuse). */
  withCreate?: boolean
  /** Make create reject with this message instead of succeeding. */
  createThrows?: string
  /** The agent the created handle reports (default: a fresh idle one). */
  createdAgent?: (sessionId: string) => FakeAgent
  /** `roots()` throws: a reduced host, not a crash. */
  rootsThrows?: boolean
  /** `get('systemPrompt')` returns undefined (no context seam available). */
  noSystemPrompt?: boolean
}

export interface Fake {
  ctx: HostContextShape
  tools: Map<string, ToolDefinition>
  registeredNames: string[]
  /** Every `systemPrompt.context()` registration, in order. */
  contexts: Array<{ name: string; order: number; text: (context: unknown) => string }>
  /** Service names the module asked `ctx.get` for. */
  serviceNames: string[]
  agents: Map<string, FakeAgent>
  createCalls: Array<{ options: Record<string, unknown> }>
  logs: string[]
  warnings: string[]
}

/** The host bag: tools, agents (create optional), settings, systemPrompt. */
export function makeFakeContext(options: FakeOptions = {}): Fake {
  const tools = new Map<string, ToolDefinition>()
  const registeredNames: string[] = []
  const contexts: Fake['contexts'] = []
  const serviceNames: string[] = []
  const agents = new Map<string, FakeAgent>()
  for (const agent of options.agents ?? []) agents.set(agent.id, agent)
  const createCalls: Fake['createCalls'] = []
  const logs: string[] = []
  const warnings: string[] = []

  const services: Record<string, unknown> = {
    systemPrompt: {
      context(entry: { name: string; order: number; text: (context: unknown) => string }): () => void {
        if (contexts.some(existing => existing.name === entry.name)) {
          throw new Error(`prompt context "${entry.name}" is already registered`)
        }
        contexts.push(entry)
        return () => {
          const index = contexts.findIndex(existing => existing.name === entry.name)
          if (index >= 0) contexts.splice(index, 1)
        }
      },
      section: () => () => {},
    },
  }
  if (options.noSystemPrompt === true) delete services.systemPrompt

  const agentService: Record<string, unknown> = {
    get: (id: string): HostAgent | undefined => agents.get(id) ?? undefined,
    roots: (): HostAgent[] => {
      if (options.rootsThrows === true) throw new Error('agents.roots() is unavailable')
      return [...agents.values()]
    },
  }
  if (options.withCreate === true) {
    agentService.create = async (raw: unknown): Promise<unknown> => {
      createCalls.push({ options: (raw ?? {}) as Record<string, unknown> })
      if (options.createThrows !== undefined) throw new Error(options.createThrows)
      const requested = String((raw as { sessionId?: unknown } | undefined)?.sessionId ?? '')
      const agent = options.createdAgent === undefined
        ? makeFakeAgent(requested, { status: 'idle', cwd: typeof (raw as { meta?: { cwd?: string } })?.meta?.cwd === 'string' ? (raw as { meta: { cwd: string } }).meta.cwd : undefined })
        : options.createdAgent(requested)
      agents.set(agent.id, agent)
      return { agent, dispose: async () => {} }
    }
  }

  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        registeredNames.push(definition.name)
        return () => {}
      },
    },
    settings: {
      writable: false,
      register<T>(_namespace: string, _schema: unknown, opts: { base?: Partial<T> }): { get(): T } {
        return { get: () => (opts.base ?? {}) as T }
      },
    },
    agents: agentService,
    get(name: string): unknown {
      serviceNames.push(name)
      return services[name]
    },
    inject(wanted: string[], callback: (context: HostContextShape) => void): void {
      if (wanted.includes('connection')) {
        (ctx as { connection?: unknown }).connection = { rpc: { handle: () => () => {} } }
      }
      callback(ctx)
    },
    on: () => () => {},
    effect(callback: () => (() => unknown) | void): () => void {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  } as unknown as HostContextShape

  return { ctx, tools, registeredNames, contexts, serviceNames, agents, createCalls, logs, warnings }
}

export interface Harness {
  root: string
  fake: Fake
  /** The CURRENT store instance (a restart replaces it over the same root). */
  store: CortexStore
  /** The CURRENT rooms service (one per root; a restart replaces it). */
  rooms: RoomService
  deps: ModuleDeps
  setConfig(patch: Partial<CortexConfig>): void
  /** = host restart: new store + new service over the SAME root. */
  restart(): void
  dispose(): Promise<void>
}

/** One harness per test: real store over a tmp root + a fake host context. */
export async function makeHarness(options: FakeOptions = {}, configPatch: Partial<CortexConfig> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cortex-rooms-'))
  const fake = makeFakeContext(options)
  let base: Partial<CortexConfig> = { ...configPatch }
  let resolved = resolveConfig(base)
  let store = new CortexStore({ root, caps: () => resolved.caps })
  await store.init()
  const deps: ModuleDeps = {
    ctx: fake.ctx,
    cfg: (): ResolvedConfig => resolved,
    store,
    log: message => { fake.logs.push(message) },
    warn: message => { fake.warnings.push(message) },
    runtime: () => ({ modules: [], errors: [] }),
  }
  let rooms = roomsService(deps)
  return {
    root,
    fake,
    deps,
    get store(): CortexStore { return store },
    get rooms(): RoomService { return rooms },
    setConfig(patch: Partial<CortexConfig>): void {
      base = { ...base, ...patch }
      resolved = resolveConfig(base)
    },
    restart(): void {
      resetRoomsService(root)
      store = new CortexStore({ root, caps: () => resolved.caps })
      deps.store = store
      rooms = roomsService(deps)
    },
    async dispose(): Promise<void> {
      resetRoomsService(root)
      await removeTempRoot(root)
    },
  }
}

/** Write a file, creating parents — used for image fixtures inside the root. */
export async function writeFixture(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes)
}

/** PNG magic + padding: bytes are what the guard checks, not a decodable image. */
export function fakePngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

/** Call a tool's execute() the way the host does. */
export async function callTool(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
  agent?: FakeAgent,
): Promise<Record<string, any>> {
  if (tool === undefined) throw new Error('the tool is not registered')
  return await tool.execute(args as never, {
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  }) as Record<string, any>
}

export async function removeTempRoot(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  await rm(path, { recursive: true, force: true }).catch(() => {})
}
