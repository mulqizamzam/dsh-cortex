/**
 * Shared test plumbing for the memory module: a fake host context (same shape as
 * `test/entry.spec.ts`, narrowed to what M2 touches) plus a real store on a tmp
 * root and a hand-built `ModuleDeps`. The plugin entry is deliberately not
 * involved, so a sibling module cannot make these tests red.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveConfig } from '../../src/host/config.ts'
import type { HostAgent, HostContextShape, ToolDefinition } from '../../src/host/dsh.ts'
import { CortexStore } from '../../src/host/store.ts'
import { ScopeCache } from '../../src/host/modules/memory/scope.ts'
import type { CortexRuntimeView, ModuleDeps, ResolvedConfig } from '../../src/host/types.ts'
import { makeTempRoot } from '../helpers.ts'

export interface ContextRegistration {
  name: string
  order?: number
  text: (context: unknown) => string
}

export interface FakeHost {
  ctx: HostContextShape
  tools: Map<string, ToolDefinition>
  contexts: ContextRegistration[]
  warnings: string[]
  logs: string[]
}

/** A cordis context that records every tool and context registration. */
export function makeFakeContext(options: { duplicateTool?: string; noSystemPrompt?: boolean } = {}): FakeHost {
  const tools = new Map<string, ToolDefinition>()
  const contexts: ContextRegistration[] = []
  const warnings: string[] = []
  const logs: string[] = []
  const host: FakeHost = {
    ctx: {
      tools: {
        register(definition: ToolDefinition): unknown {
          if (options.duplicateTool === definition.name || tools.has(definition.name)) {
            throw new Error(`tool "${definition.name}" is already registered`)
          }
          tools.set(definition.name, definition)
          return () => {}
        },
      },
      settings: { writable: false, register: () => ({ get: () => ({}) }) } as never,
      agents: { get: () => undefined, roots: () => [] },
      get(name: string): unknown {
        if (name !== 'systemPrompt' || options.noSystemPrompt === true) return undefined
        return {
          // Mirrors the REAL host signature (systemPrompt.context takes ONE
          // PromptContext object; non-finite order throws TypeError; duplicate
          // name throws) — parent fix, see runtime.ts. A 2-arg caller now fails
          // loudly in tests instead of passing on a fake the host never offers.
          context(entry: { name: string; order: number; text: string | ((context: unknown) => string) }): unknown {
            if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string') {
              throw new TypeError('prompt context entry must be an object with a name')
            }
            if (!Number.isFinite(entry.order)) throw new TypeError(`prompt context "${entry.name}" order must be a finite number`)
            if (contexts.some(row => row.name === entry.name)) throw new Error(`context "${entry.name}" is already registered`)
            contexts.push({
              name: entry.name,
              order: entry.order,
              text: typeof entry.text === 'function' ? entry.text : () => entry.text as string,
            })
            return () => {}
          },
        }
      },
      inject: (_services: string[], callback: (context: HostContextShape) => void) => callback(host.ctx),
      on: () => () => {},
      effect: (callback: () => unknown) => {
        callback()
        return () => {}
      },
    } as unknown as HostContextShape,
    tools,
    contexts,
    warnings,
    logs,
  }
  return host
}

/** A scope cache whose git answers are pinned, so tests never shell out. */
export function fakeScopes(scope: { pid?: string; branch: string | null }): ScopeCache {
  return new ScopeCache({
    repoRoot: async cwd => cwd,
    originRemote: async () => undefined,
    currentBranch: async () => scope.branch ?? undefined,
    projectId: async input => scope.pid ?? `pid${input.cwd.replace(/[^a-z0-9]/gi, '').slice(-12)}`,
  })
}

/** What `apply(ctx, patch)` accepts: any subset, nested one level. */
export type ConfigPatch = Parameters<typeof resolveConfig>[0]

export interface Harness {
  host: FakeHost
  deps: ModuleDeps
  store: CortexStore
  root: string
  cwd: string
  scopes: ScopeCache
  readonly config: ResolvedConfig
  /** Replace the live config the way an entry hot-reload does (re-apply). */
  setConfig(patch: ConfigPatch): ResolvedConfig
  /** Args merged with this session's cwd, as the tools do internally. */
  sessionArgs(extra?: Record<string, unknown>): Record<string, unknown>
}

export async function makeHarness(
  config: ConfigPatch = {},
  options: { pid?: string; branch?: string | null; duplicateTool?: string; noSystemPrompt?: boolean } = {},
): Promise<Harness> {
  const root = await makeTempRoot('dsh-cortex-memory-')
  const cwd = join(root, 'repo')
  await mkdir(cwd, { recursive: true })
  const host = makeFakeContext({ duplicateTool: options.duplicateTool, noSystemPrompt: options.noSystemPrompt })
  const view: CortexRuntimeView = { modules: [], errors: [] }
  let current = resolveConfig(config)
  const store = new CortexStore({ root, caps: () => current.caps, warn: message => { host.warnings.push(message) } })
  const deps: ModuleDeps = {
    ctx: host.ctx,
    cfg: () => current,
    store,
    log: message => { host.logs.push(message) },
    warn: message => { host.warnings.push(message) },
    runtime: () => view,
  }
  await store.init()
  return {
    host,
    deps,
    store,
    root,
    cwd,
    scopes: fakeScopes({ pid: options.pid ?? 'testproject000', branch: options.branch === undefined ? null : options.branch }),
    get config(): ResolvedConfig {
      return current
    },
    setConfig(patch: ConfigPatch): ResolvedConfig {
      // Merge one level deep, the way the host layers a settings document.
      const merged: Record<string, unknown> = { ...current }
      for (const [key, value] of Object.entries(patch ?? {})) {
        const previous = merged[key]
        merged[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof previous === 'object' && previous !== null
          ? { ...previous as object, ...value as object }
          : value
      }
      current = resolveConfig(merged)
      return current
    },
    sessionArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
      return { cwd, sessionId: 'session-1', ...extra }
    },
  }
}

/** The agent object the host hands to `execute` and to the assembly context. */
export function fakeAgent(cwd: string, id = 'session-1'): HostAgent {
  return { id, status: 'idle', session: { header: { cwd } }, ctx: { on: () => () => {} } } as unknown as HostAgent
}

/** Write a state file by hand: the render edge must survive un-sanitised data. */
export async function writeRawEntry(root: string, track: 'user' | 'global', entry: Record<string, unknown>): Promise<string> {
  const dir = join(root, track, 'entries')
  await mkdir(dir, { recursive: true })
  const id = String(entry.id)
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  return id
}

/** A batch of filler entries, realistic enough to blow every budget. */
export async function seedEntries(store: CortexStore, count: number, options: { track?: 'user' | 'global' | 'project'; pid?: string; prefix?: string } = {}): Promise<void> {
  const track = options.track ?? 'user'
  for (let index = 0; index < count; index += 1) {
    const result = await store.addEntry({
      scope: { track, ...(track === 'project' ? { pid: options.pid } : {}) },
      content: `${options.prefix ?? 'junk fact'} number ${index} — ${'detail '.repeat(14)}`,
      importance: index % 5 === 0 ? 5 : 2,
    })
    if (!result.ok) throw new Error(`seed failed at ${index}: ${result.error}`)
  }
}
