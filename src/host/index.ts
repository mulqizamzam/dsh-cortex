import { errorMessage, makeLogger } from '../lib/errors.ts'
import { neutralize } from '../lib/sanitize.ts'
import { resolveStateRoot } from '../lib/home.ts'
import { Config, DEFAULT_CONFIG, INJECT_LABEL, resolveConfig } from './config.ts'
import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from './dsh.ts'
import type { HostContextShape, HostRpcResult } from './dsh-internal.ts'
import * as statusModule from './modules/status/index.ts'
import * as memoryModule from './modules/memory/index.ts'
import * as todoModule from './modules/todo/index.ts'
import * as logsModule from './modules/logs/index.ts'
import * as progressModule from './modules/progress/index.ts'
import * as roomsModule from './modules/rooms/index.ts'
import * as sessionsModule from './modules/sessions/index.ts'
import * as delegateModule from './modules/delegate/index.ts'
import * as purgeModule from './modules/purge/index.ts'
import * as promptsModule from './modules/prompts/index.ts'
import * as conflictModule from './modules/conflict/index.ts'
import * as boardModule from './modules/board/index.ts'
import * as decisionsModule from './modules/decisions/index.ts'
import { CORTEX_PING_ENDPOINT, CORTEX_READ_CHANNEL, CORTEX_WRITE_CHANNEL } from './rpc-channels.ts'
import { CortexStore } from './store.ts'
import type { CortexConfig, CortexModule, CortexRuntimeView, ModuleDeps, ModuleStatus, ResolvedConfig } from './types.ts'
import { refuse } from './rpc-error.ts'

/**
 * Plugin entry (HOST-API §1) under P4: `apply` never throws. An internal
 * failure degrades to a status-only `cortex_status` tool that reports the
 * failure string — memory-evolve killed the whole GUI by throwing here, so the
 * catch is deliberately total.
 */
export const name = 'dsh-cortex'
export const VERSION = '0.1.0'

/**
 * Cordis service deps. `connection` is NOT listed: it is web-only, so it is
 * reached through `ctx.inject(['connection'], …)` and a headless profile still
 * boots (HOST-API §5).
 */
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']

/** A module may export endpoint maps alongside apply; handlers get (payload, deps). */
export type ModuleEndpoint = (payload: unknown, deps: ModuleDeps) => Promise<HostRpcResult<unknown>>
export interface EndpointsModule extends CortexModule {
  readEndpoints?: Record<string, ModuleEndpoint>
  writeEndpoints?: Record<string, ModuleEndpoint>
}

/** Wiring order; M4 (prompts) is wired last (it depends on nothing but the
 *  store and the system-prompt seam, so appending keeps the existing order). */
export const MODULES: EndpointsModule[] = [
  statusModule, memoryModule, todoModule, logsModule, progressModule, roomsModule, sessionsModule, delegateModule, purgeModule, promptsModule, conflictModule, boardModule, decisionsModule,
] as unknown as EndpointsModule[]

/** F9: each boot owns the diagnostics it writes. `cortexRuntime()` hands out the
 *  LIVE view, so "am I still the runtime being read?" is decided by identity with
 *  the active handle — never by a captured array reference. */
interface BootHandle {
  readonly view: CortexRuntimeView
  readonly errors: string[]
}

/** Label for an async init outcome that belongs to a boot this runtime replaced. */
const SUPERSEDED_STATE = 'state (superseded boot): '

function newBootHandle(modules: readonly ModuleStatus[] = [], bootError?: string): BootHandle {
  const errors: string[] = []
  const view: CortexRuntimeView = { modules, errors, ...(bootError === undefined ? {} : { bootError }) }
  return { view, errors }
}

let activeBoot: BootHandle = newBootHandle()

/** F9: one async init outcome, reported to the diagnostics that are read NOW.
 *  A boot that has been replaced (a reload, or a boot that threw after starting
 *  its scaffold) must not write into the array it captured: nothing reads that
 *  array any more, so a delayed failure became invisible to `cortex_status`.
 *  Such a boot also must not claim to be the current failure, so its outcome is
 *  labelled, and at most one such notice is kept — load/unload churn cannot grow
 *  the active diagnostics without bound. */
function publishStateOutcome(handle: BootHandle, detail: string): void {
  if (handle === activeBoot) {
    handle.errors.push(`state: ${detail}`)
    return
  }
  const active = activeBoot.errors
  for (let index = active.length - 1; index >= 0; index -= 1) {
    if (active[index].startsWith(SUPERSEDED_STATE)) active.splice(index, 1)
  }
  active.push(`${SUPERSEDED_STATE}${detail}`)
}

/** Current wiring view (module states, boot error). */
export function cortexRuntime(): CortexRuntimeView {
  return activeBoot.view
}

export { Config, DEFAULT_CONFIG, INJECT_LABEL, resolveConfig, CortexStore }
export { CORTEX_PING_ENDPOINT, CORTEX_READ_CHANNEL } from './rpc-channels.ts'
export * from './types.ts'
export type { HostContextShape, RpcResult, ToolDefinition } from './dsh.ts'

export function apply(rawContext: unknown, rawConfig: Partial<CortexConfig> = {}): void {
  const log = makeLogger('dsh-cortex')
  const ctx = rawContext as HostContextShape
  try {
    const view = boot(ctx, rawConfig, log)
    log.info(`ready — ${(view.modules as ModuleStatus[]).map(item => `${item.name}:${item.state}`).join(', ') || 'no modules'}`)
  } catch (error) {
    const detail = errorMessage(error)
    // F9: the degraded view becomes the active owner too, so a `store.init()`
    // started by the boot that just threw reports into diagnostics that are read,
    // instead of into the array it captured before the throw.
    const failed = newBootHandle([{ name: 'boot', state: 'failed', error: detail, tools: [] }], detail)
    failed.errors.push(`boot: ${detail}`)
    activeBoot = failed
    console.error('[dsh-cortex] boot failed; registering status-only tool:', detail)
    log.warn(`boot failed; registering status-only tool (${detail})`)
    try {
      registerToolSafe(ctx, defineTool({
        name: 'cortex_status',
        description: 'dsh-cortex failed to start; this status-only tool reports why. No other cortex_* tool is available this session.',
        parameters: { type: 'object', properties: {} },
        output: { schema: JSON_OBJECT_OUTPUT, render: (_args: Record<string, unknown>, value: never) => text(value) },
        execute: async () => ({ plugin: 'dsh-cortex', state: 'failed', error: neutralize(detail), hint: 'Fix the cause and restart the host; plugin data on disk is untouched.' }),
      } as never))
    } catch (fallbackError) {
      // Even the degraded path failing must not escape (P4).
      log.warn(`fallback status tool could not register: ${errorMessage(fallbackError)}`)
    }
  }
}

function boot(ctx: HostContextShape, rawConfig: Partial<CortexConfig>, log: ReturnType<typeof makeLogger>): CortexRuntimeView {
  let resolved = resolveConfig(rawConfig)
  const scope = ctx.settings.register<CortexConfig>('cortex', Config, { base: rawConfig as CortexConfig, applies: 'live' })
  try {
    resolved = resolveConfig(scope.get())
  } catch (error) {
    log.warn(`settings read failed, using composed defaults: ${errorMessage(error)}`)
  }

  // State root: config override > host `dshHomePath` service > env fallback (§2).
  const root = resolved.stateRoot !== '' ? resolved.stateRoot : resolveStateRoot(name2 => ctx.get(name2))
  const store = new CortexStore({ root, caps: () => resolved.caps, warn: message => log.warn(message) })
  const modules: ModuleStatus[] = []
  const handle = newBootHandle(modules)
  const view = handle.view
  const errors = handle.errors
  activeBoot = handle
  const cfg = (): ResolvedConfig => resolved

  // F9: `store.init()` is deliberately fire-and-forget (a slow state scaffold
  // must not fail or delay the boot). Its outcome is therefore published through
  // the handle, which resolves to whatever diagnostics are live at settlement.
  void store.init().then(result => {
    if (!result.ok) publishStateOutcome(handle, result.error)
  }, error => {
    publishStateOutcome(handle, errorMessage(error))
    log.warn(`state scaffold failed: ${errorMessage(error)}`)
  })

  ctx.on('settings/updated', ((namespace: string, next: CortexConfig) => {
    if (namespace !== 'cortex') return
    try {
      const updated = resolveConfig(next)
      // F8: the state root is bound at construction (the store captured it), so a
      // live patch must not leave `cfg().stateRoot` claiming a root nothing in the
      // runtime reads. Pin it to the active root and say so, once per change.
      if (updated.stateRoot !== root) {
        const detail = `config: stateRoot change to '${updated.stateRoot}' ignored — immutable after boot (active root '${root}')`
        errors.push(detail)
        log.warn(detail)
        resolved = { ...updated, stateRoot: root }
      } else {
        resolved = updated
      }
      log.info('config swapped (live)')
    } catch (error) {
      // A bad patch must not half-apply: the previous config stays in force.
      log.warn(`config swap failed, keeping previous: ${errorMessage(error)}`)
    }
  }) as never)

  // Endpoint maps merge in AFTER the module loop (apply binds services); the
  // dispatchers below read the live objects at REQUEST time, so mount order is
  // safe and early requests answer honestly 'unknown-endpoint'.
  const readMap: Record<string, ModuleEndpoint> = {}
  const writeMap: Record<string, ModuleEndpoint> = {}

  const dispatcher = (side: 'read' | 'write', map: Record<string, ModuleEndpoint>) =>
    async (endpoint: string, payload: unknown): Promise<HostRpcResult<unknown>> => {
      if (side === 'read' && endpoint === CORTEX_PING_ENDPOINT) {
        return { ok: true, value: { plugin: 'dsh-cortex', version: VERSION, stateRoot: neutralize(store.root), injectEnabled: cfg().inject.enabled, echoKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [] } }
      }
      const handler = map[endpoint]
      if (handler === undefined) return refuse(`unknown cortex ${side} endpoint: ${String(endpoint)}`, 'unknown-endpoint')
      try {
        return await handler(payload, deps)
      } catch (error) {
        // Never let a handler throw at the transport (mirrors module rpc wrappers).
        return { ok: false, error: { message: neutralize(errorMessage(error)) } }
      }
    }

  // Browser transport (HOST-API §5): loopback-fenced RPC channels only, never
  // a public /api route. Read = status + module read endpoints; write = human
  // (UI) actions gated per-handler by confirm strings (RPC-ENDPOINTS contract).
  try {
    ctx.inject(['connection'], (injected: HostContextShape) => {
      try {
        const connection = injected.connection
        if (connection === undefined) return
        connection.rpc.handle(CORTEX_READ_CHANNEL, dispatcher('read', readMap), { authority: 'loopback' })
        connection.rpc.handle(CORTEX_WRITE_CHANNEL, dispatcher('write', writeMap), { authority: 'loopback' })
      } catch (error) {
        errors.push(`rpc: ${errorMessage(error)}`)
        log.warn(`rpc mount failed: ${errorMessage(error)}`)
      }
    })
  } catch (error) {
    // An absent service must not abort module wiring, but it must be reported.
    errors.push(`inject(connection): ${errorMessage(error)}`)
    log.warn(`connection service unavailable, rpc not mounted: ${errorMessage(error)}`)
  }

  const deps: ModuleDeps = { ctx, cfg, store, log: message => log.info(message), warn: message => log.warn(message), runtime: () => view }

  // Endpoint merge (parent integration rule): first writer wins, collisions are
  // logged — a silent shadow would let one module steal another's name. F5: this
  // runs only for a module that finished applying (see the loop below).
  const readOwners: Record<string, string> = {}
  const writeOwners: Record<string, string> = {}
  const publishEndpoints = (module: EndpointsModule): void => {
    for (const [key, handler] of Object.entries(module.readEndpoints ?? {})) {
      const owner = readOwners[key]
      if (owner !== undefined) {
        // F7: precedence is unchanged (first writer wins) — the conflict itself is
        // now observable through runtime.errors, not only through the log.
        const detail = `endpoint conflict: READ '${key}' from '${module.name}' ignored, kept '${owner}'`
        errors.push(detail)
        log.warn(detail)
        continue
      }
      readOwners[key] = module.name
      readMap[key] = handler as ModuleEndpoint
    }
    for (const [key, handler] of Object.entries(module.writeEndpoints ?? {})) {
      const owner = writeOwners[key]
      if (owner !== undefined) {
        const detail = `endpoint conflict: WRITE '${key}' from '${module.name}' ignored, kept '${owner}'`
        errors.push(detail)
        log.warn(detail)
        continue
      }
      writeOwners[key] = module.name
      writeMap[key] = handler as ModuleEndpoint
    }
  }

  for (const module of MODULES) {
    const status: ModuleStatus = { name: module.name, state: 'skipped', tools: [] }
    modules.push(status)
    try {
      module.apply(deps)
      // F5: a module that throws after binding its handlers answers
      // 'unknown-endpoint' instead of exposing a half-initialized one. Failure
      // isolation is unchanged: the remaining modules still run.
      publishEndpoints(module)
      status.state = 'ok'
      // F6: report what the registry actually holds, not what the module declares.
      status.tools = mountedToolNames(ctx, module)
    } catch (error) {
      status.state = 'failed'
      status.error = errorMessage(error)
      errors.push(`module:${module.name} ${status.error}`)
      log.warn(`module "${module.name}" failed, continuing: ${status.error}`)
    }
  }

  // Contract fidelity (parent, artifact-e2e found the gap): pending.list has no
  // module owner — the queue itself is store-generic, so the entry mounts it.
  readMap['pending.list'] = async (payload) => {
    const p = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
    const status = p.status === 'approved' || p.status === 'rejected' ? p.status : 'pending'
    const listed = await store.listPending({ status, limit: 500 })
    if (listed.ok !== true) return { ok: false, error: { message: listed.error } }
    return { ok: true, value: { items: listed.data, truncated: listed.data.length >= 500 } }
  }

  // pending.approve is routed BY KIND: each kind is owned by the module that
  // understands it; kinds with no approver answer honestly, never silently.
  const memoryApprove = writeMap['pending.approve']
  writeMap['pending.approve'] = async (payload, d) => {
    const id = (payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).id : undefined)
    if (typeof id !== 'string') return refuse('pending.approve needs { id }', 'bad-request')
    const listed = await d.store.listPending({ status: 'pending', limit: 500 })
    const item = listed.ok === true ? listed.data.find(row => row.id === id) : undefined
    if (item === undefined) return refuse(`no pending proposal '${id}' (already decided?)`, 'not-found')
    if (item.kind === 'memory') return memoryApprove !== undefined ? memoryApprove(payload, d) : refuse('memory approver module unavailable', 'no-approver')
    if (item.kind === 'prompt') {
      // The prompts module owns this rule (pending.ts); the entry only routes.
      const decision = await promptsModule.approvePendingPrompt(d.store, item)
      return decision.ok ? { ok: true, value: decision } : refuse(decision.message, 'approve-failed')
    }
    return refuse(`no approver wired for pending kind '${item.kind}' yet`, 'unsupported-kind')
  }
  return view
}

/** Tool ids a module file declares alongside `apply` (convention, not host API). */
function moduleToolNames(module: CortexModule): string[] {
  const declared = (module as { TOOLS?: readonly string[] }).TOOLS
  return Array.isArray(declared) ? [...declared] : []
}

/** F6: keep only the declared ids the host registry really holds, so a refused
 * registration (or a host that never mounted it) is not reported as healthy.
 * A reduced host without the lookup falls back to the declared list. */
function mountedToolNames(ctx: HostContextShape, module: CortexModule): string[] {
  const declared = moduleToolNames(module)
  const lookup = ctx.tools.get
  if (typeof lookup !== 'function') return declared
  return declared.filter(name => {
    try { return lookup.call(ctx.tools, name) !== undefined } catch { return false }
  })
}
