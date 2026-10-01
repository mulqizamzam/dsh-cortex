/**
 * Shared plumbing for the M3 (todo + logs + progress) suites: a real
 * `CortexStore` over a tmp state root (so caps, quarantine and day files are
 * the production ones), a fake cordis ctx that records tool registrations and
 * prompt-context registrations, and a scope cache with injected probes so no
 * test needs a git binary or a real repository.
 */
import type { HostContextShape, ToolDefinition } from '../../src/host/dsh.ts'
import { CortexStore } from '../../src/host/store.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import type { CortexCaps } from '../../src/lib/caps.ts'
import { hashId } from '../../src/lib/pid.ts'
import { TaskScopeCache } from '../../src/host/modules/todo/scope.ts'
import type { ModuleDeps, ResolvedConfig } from '../../src/host/types.ts'
import type { LogReviewConfig } from '../../src/host/modules/logs/nudge.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'

/** What a `systemPrompt.context` registration looked like when it happened. */
export interface ContextRegistration {
  name: string
  order: number
  text: (context: unknown) => string
}

export interface FakeCtxOptions {
  /** Make `systemPrompt.context` throw, to prove a refused seam is survivable. */
  contextThrows?: boolean
}

export interface FakeCtx {
  ctx: HostContextShape
  tools: Map<string, ToolDefinition>
  contexts: ContextRegistration[]
  listeners: Map<string, Array<(payload: never) => unknown>>
  registrationsRefused: string[]
  emit(event: string, ...args: unknown[]): void
}

/** A cordis context that records instead of wiring into a real host. */
export function makeFakeCtx(options: FakeCtxOptions = {}): FakeCtx {
  const tools = new Map<string, ToolDefinition>()
  const contexts: ContextRegistration[] = []
  const listeners = new Map<string, Array<(payload: never) => unknown>>()
  const registrationsRefused: string[] = []
  const systemPrompt = {
    context(value: { name: string; order: number; text: (context: unknown) => string }): () => void {
      if (options.contextThrows === true) throw new Error('duplicate prompt context')
      contexts.push({ name: value.name, order: value.order, text: value.text })
      return () => {}
    },
    section(value: { name: string; order: number; text: () => string }): () => void {
      contexts.push({ name: value.name, order: value.order, text: value.text })
      return () => {}
    },
  }
  const ctx = {
    tools: {
      register(definition: ToolDefinition): void {
        if (tools.has(definition.name)) {
          registrationsRefused.push(definition.name)
          throw new Error(`tool "${definition.name}" is already registered`)
        }
        tools.set(definition.name, definition)
      },
    },
    settings: { writable: false, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get(name: string): unknown {
      return name === 'systemPrompt' ? systemPrompt : undefined
    },
    inject: (_services: string[], callback: (context: HostContextShape) => void) => callback(ctx),
    on(name: string, listener: (...args: never[]) => unknown): () => void {
      const list = listeners.get(name) ?? []
      list.push(listener as (payload: never) => unknown)
      listeners.set(name, list)
      return () => {
        listeners.set(name, list.filter(item => item !== (listener as (payload: never) => unknown)))
      }
    },
    effect(callback: () => (() => unknown) | void): () => void {
      callback()
      return () => {}
    },
  } as unknown as HostContextShape
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      ;(listener as (...items: unknown[]) => unknown)(...args)
    }
  }
  return { ctx, tools, contexts, listeners, registrationsRefused, emit }
}

/** One task-domain test harness: store + deps + scope cache, tmp-rooted. */
export interface Harness {
  root: string
  store: CortexStore
  deps: ModuleDeps
  fake: FakeCtx
  /** Everything the store or a module warned about (P4 visibility). */
  warnings: string[]
  scopes: TaskScopeCache
  /** Live config object; mutate a field to emulate a `settings/updated` swap. */
  config: ResolvedConfig & LogReviewConfig
  clock: { value: Date }
  cleanup(): Promise<void>
}

export interface HarnessOptions {
  caps?: Partial<CortexCaps>
  config?: { everyTurns?: number; injectTodo?: boolean }
  now?: Date
}

/** A cwd whose pid is derived from the path alone — deterministic, no git. */
export function makeScopes(repoCwds: readonly string[] = ['/repo/alpha', '/repo/beta']): TaskScopeCache {
  const known = new Set(repoCwds)
  return new TaskScopeCache(
    {
      repoRoot: async (cwd: string) => (cwd.startsWith('/repo/') ? (known.has(cwd) ? cwd : '/repo/alpha') : undefined),
      originRemote: async () => undefined,
      // The unified cache probes the branch too; keep this seam hermetic.
      currentBranch: async () => undefined,
      projectId: async ({ cwd }) => hashId(cwd),
    },
    { now: () => Date.now() },
  )
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await makeTempRoot('dsh-cortex-tasks-')
  const clock = { value: options.now ?? new Date('2026-03-04T05:06:07.000Z') }
  const fake = makeFakeCtx()
  const warnings: string[] = []
  const resolved = resolveConfig({
    caps: { ...DEFAULT_CAPS, ...(options.caps ?? {}) },
    ...(options.config?.everyTurns === undefined ? {} : { logReview: { everyTurns: options.config.everyTurns } } as never),
  }) as ResolvedConfig & LogReviewConfig
  if (options.config?.everyTurns !== undefined) resolved.logReview = { everyTurns: options.config.everyTurns }
  if (options.config?.injectTodo !== undefined) resolved.inject = { ...resolved.inject, todo: options.config.injectTodo }
  const store = new CortexStore({
    root,
    caps: () => resolved.caps,
    warn: message => warnings.push(message),
    now: () => clock.value,
  })
  const deps: ModuleDeps = {
    ctx: fake.ctx,
    cfg: () => resolved,
    store,
    log: () => {},
    warn: message => warnings.push(message),
    runtime: () => ({ modules: [], errors: [] }),
  }
  return {
    root,
    store,
    deps,
    fake,
    warnings,
    scopes: makeScopes(),
    config: resolved,
    clock,
    cleanup: async () => {
      await removeTempRoot(root)
    },
  }
}

/** The `agent` object the host hands a tool/context provider. */
export function fakeAgent(cwd: string | undefined, id = 'session-1'): unknown {
  return {
    id,
    status: 'idle',
    session: { header: { id, ...(cwd === undefined ? {} : { cwd }) } },
    ctx: { on: () => () => {} },
  }
}

/** Run a registered tool's execute() the way the host does. */
export async function runTool(fake: FakeCtx, name: string, args: Record<string, unknown>, agent?: unknown): Promise<Record<string, unknown>> {
  const definition = fake.tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} was never registered`)
  const execution = { signal: new AbortController().signal, ...(agent === undefined ? {} : { agent }) } as {
    signal: AbortSignal
    agent?: import('../../src/host/dsh.ts').HostAgent
  }
  const value = await definition.execute(args as never, execution)
  return (typeof value === 'string' ? { message: value } : value) as Record<string, unknown>
}

/** The text a registered prompt context contributes for one assembly context. */
export function renderContext(fake: FakeCtx, name: string, context: unknown): string {
  const registration = fake.contexts.find(item => item.name === name)
  if (registration === undefined) throw new Error(`context ${name} was never registered`)
  return registration.text(context)
}

/** The envelope as a test reads it: the union, flattened for assertions. */
export interface EndpointCall {
  ok: boolean
  value?: unknown
  error?: { code?: string; message: string }
}

/** Endpoint call helper: keeps the `{ok,value}|{ok,error}` envelope readable. */
export async function callEndpoint(map: Record<string, (payload: unknown) => unknown>, endpoint: string, payload: unknown): Promise<EndpointCall> {
  const handler = map[endpoint]
  if (handler === undefined) return { ok: false, error: { code: 'unknown-endpoint', message: `${endpoint} is not mapped` } }
  return (await handler(payload)) as EndpointCall
}

export const ALPHA = '/repo/alpha'
export const BETA = '/repo/beta'
export const alphaPid = (): string => hashId(ALPHA)
export const betaPid = (): string => hashId(BETA)