/**
 * Shared plumbing for the M4 (prompts) suite: a REAL `CortexStore` over a tmp
 * state root (so caps, quarantine and the inject file are the production ones),
 * a fake cordis ctx that records tool and prompt-context registrations with the
 * host's actual `context(entry)` signature, and a `ModuleDeps` built by hand —
 * the plugin entry is deliberately not involved, so a sibling module cannot make
 * these tests red.
 */
import type { HostContextShape, ToolDefinition } from '../../src/host/dsh.ts'
import { CortexStore } from '../../src/host/store.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import type { CortexCaps } from '../../src/lib/caps.ts'
import * as promptsModule from '../../src/host/modules/prompts/index.ts'
import { PromptsService } from '../../src/host/modules/prompts/service.ts'
import type { ModuleDeps, PromptDoc, ResolvedConfig } from '../../src/host/types.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'

export interface ContextRegistration {
  name: string
  order: number
  text: (context: unknown) => string
}

export interface FakeCtx {
  ctx: HostContextShape
  tools: Map<string, ToolDefinition>
  contexts: ContextRegistration[]
  refused: string[]
  registrations: string[]
  emit(event: string, ...args: unknown[]): void
}

/** A cordis context that records instead of wiring into a real host. */
export function makeFakeCtx(options: { contextThrows?: boolean; noSystemPrompt?: boolean } = {}): FakeCtx {
  const tools = new Map<string, ToolDefinition>()
  const contexts: ContextRegistration[] = []
  const refused: string[] = []
  const registrations: string[] = []
  const systemPrompt = {
    context(entry: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void {
      if (options.contextThrows === true) throw new Error('duplicate prompt context')
      if (typeof entry?.name !== 'string') throw new TypeError('prompt context entry must be an object with a name')
      if (!Number.isFinite(entry.order)) throw new TypeError(`prompt context "${entry.name}" order must be a finite number`)
      if (contexts.some(row => row.name === entry.name)) throw new Error(`context "${entry.name}" is already registered`)
      registrations.push(entry.name)
      contexts.push({
        name: entry.name,
        order: entry.order,
        text: typeof entry.text === 'function' ? entry.text : () => String(entry.text ?? ''),
      })
      return () => {}
    },
  }
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition): void {
        if (tools.has(definition.name)) {
          refused.push(definition.name)
          throw new Error(`tool "${definition.name}" is already registered`)
        }
        tools.set(definition.name, definition)
      },
    },
    settings: { writable: false, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get(name: string): unknown {
      return name === 'systemPrompt' && options.noSystemPrompt !== true ? systemPrompt : undefined
    },
    inject: (_services: string[], callback: (context: HostContextShape) => void) => callback(ctx),
    on(name: string, listener: (...args: never[]) => unknown): () => void {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        listeners.set(name, list.filter(item => item !== listener))
      }
    },
    effect(callback: () => (() => unknown) | void): () => void {
      callback()
      return () => {}
    },
  } as unknown as HostContextShape
  return {
    ctx,
    tools,
    contexts,
    refused,
    registrations,
    emit: (event: string, ...args: unknown[]): void => {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as (...items: unknown[]) => unknown)(...args)
      }
    },
  }
}

export interface HarnessOptions {
  caps?: Partial<CortexCaps>
  promptsEnabled?: boolean
  injectEnabled?: boolean
  /** Reuse a root (restart-persistence tests build a second service on the same dir). */
  root?: string
}

export interface Harness {
  root: string
  store: CortexStore
  deps: ModuleDeps
  svc: PromptsService
  fake: FakeCtx
  config: ResolvedConfig
  warnings: string[]
  logs: string[]
  /** A live service over a SECOND store instance on the same root (restart). */
  reopen(): Promise<PromptsService>
  cleanup(): Promise<void>
}

/** Build the harness and mount the module the way the parent's loop does. */
export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? await makeTempRoot('dsh-cortex-prompts-')
  const fake = makeFakeCtx()
  const warnings: string[] = []
  const logs: string[] = []
  const config = resolveConfig({
    caps: { ...DEFAULT_CAPS, ...(options.caps ?? {}) },
    prompts: { enabled: options.promptsEnabled ?? true },
    inject: { ...DEFAULT_INJECT, enabled: options.injectEnabled ?? true },
  })
  const store = new CortexStore({ root, caps: () => config.caps, warn: message => warnings.push(message) })
  const deps: ModuleDeps = {
    ctx: fake.ctx,
    cfg: () => config,
    store,
    log: message => logs.push(message),
    warn: message => warnings.push(message),
    runtime: () => ({ modules: [], errors: [] }),
  }
  await store.init()
  promptsModule.apply(deps)
  const svc = promptsModule.getPromptsService()
  if (svc === null) throw new Error('prompts.apply() did not build a service')
  return {
    root,
    store,
    deps,
    svc,
    fake,
    config,
    warnings,
    logs,
    reopen: async () => {
      const reopened = new CortexStore({ root, caps: () => config.caps, warn: message => warnings.push(message) })
      const second = new PromptsService({ ...deps, store: reopened })
      return second
    },
    cleanup: async () => {
      promptsModule.disposePrompts()
      await removeTempRoot(root)
    },
  }
}

const DEFAULT_INJECT = { enabled: true, user: true, global: true, project: true, todo: true }

/** The agent object the host hands to `execute` and to the assembly context. */
export function fakeAgent(id = 'session-1', cwd = '/repo/alpha'): unknown {
  return { id, status: 'idle', session: { header: { id, cwd } }, ctx: { on: () => () => {} } }
}

/** Run a registered tool's `execute` the way the host does. */
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

/** The text the registered `cortex:prompts` context contributes for one assembly. */
export function renderPromptsContext(fake: FakeCtx, context: unknown): string {
  const registration = fake.contexts.find(item => item.name === 'cortex:prompts')
  if (registration === undefined) throw new Error('cortex:prompts was never registered')
  return registration.text(context)
}

/** A saved prompt, through the human (endpoint) path — every test starts here. */
export async function saveDoc(harness: Harness, input: { title: string; body: string; category?: string }): Promise<PromptDoc> {
  const result = await harness.svc.saveDoc(input)
  if (!result.ok || result.doc === undefined || result.doc === null) throw new Error(`saveDoc failed: ${result.message}`)
  return result.doc
}

/** Await the fire-and-forget queue writes so a test can read the file honestly. */
export const settle = (svc: PromptsService): Promise<void> => svc.flushQueueWrites()

/** Endpoint call helper: keeps the `{ok,value}|{ok,error}` envelope readable. */
export interface EndpointCall {
  ok: boolean
  value?: unknown
  error?: { code?: string; message: string }
}

export async function callEndpoint(
  map: Record<string, (payload: unknown) => unknown>,
  endpoint: string,
  payload: unknown,
): Promise<EndpointCall> {
  const handler = map[endpoint]
  if (handler === undefined) return { ok: false, error: { code: 'unknown-endpoint', message: `${endpoint} is not mapped` } }
  return (await handler(payload)) as EndpointCall
}

/** The value of a successful endpoint call, typed loosely for assertions. */
export function valueOf(result: EndpointCall): Record<string, unknown> {
  if (!result.ok) throw new Error(`endpoint failed: ${result.error?.message ?? 'unknown'}`)
  return (result.value ?? {}) as Record<string, unknown>
}

