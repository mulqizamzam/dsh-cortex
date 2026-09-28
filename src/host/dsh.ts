/** RULE (host issue-class #53): every `description` here — tool descriptions and
 * parameter descriptions alike — must contain no `{{`/`}}`; brace pairs in
 * model-visible text can throw in the host prompt renderer and deadlock every
 * turn. Interpolate nothing from user data into a description; run dynamic text
 * through `neutralize()` from src/lib/sanitize.ts.
 *
 * Minimal typed model of the host surface cortex uses — transcribed from
 * docs/HOST-API.md (§1 entry, §2 tools, §4 settings, §5 transport, §6 agents).
 * Everything optional in the host is optional here, so a headless or reduced
 * profile type-checks and degrades instead of crashing.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * HOST-API §5 wire envelope.
 *
 * `details` is not optional on the host's side: every branch of its error
 * union requires it, with a per-code shape (rpc.schema.ts:32). Omitting it
 * makes the whole reply unparseable, so it is part of the type here — see
 * `src/host/rpc-error.ts` for why a plugin may only use the codes whose
 * details is the empty object.
 */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string; details?: Record<string, unknown> } }

/** HOST-API §5: keep one call shape; rc.2 requires authority, later hosts ignore it. */
export type HostRpcAuthority = 'loopback' | 'trusted-host'
export type HostRpcHandler = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>

export interface HostConnectionHandle {
  rpc: {
    handle(channel: string, handler: HostRpcHandler, options: { authority: HostRpcAuthority }): unknown
  }
}

/** HOST-API §4. */
export interface HostSettingsScope<T> {
  get(): T
}

export interface HostSettingsService {
  readonly writable: boolean
  register<T>(
    namespace: string,
    schema: unknown,
    options: { base?: Partial<T>; applies: 'live' | 'restart'; validate?: (value: T) => void },
  ): HostSettingsScope<T>
}

/** HOST-API §2: parameters/output stay inside the supported JSON-Schema subset. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: never) => Array<{ type: 'text'; text: string }>
    presentationMeta?: (args: unknown, value: unknown) => JsonValue
  }
  execute: (args: never, execution: { signal: AbortSignal; agent?: HostAgent; concludeTurn?: () => void }) => Promise<unknown>
  presentCall?: (args: never) => Record<string, unknown>
  presentResult?: () => Record<string, unknown>
}

/** HOST-API §6 (subset). */
export interface HostUserMessage {
  id: string
  role: 'user'
  content: Array<{ type: string; text?: string }>
  source: { kind: string; plugin?: string }
}

export interface HostAgent {
  id: string
  status: 'idle' | 'running'
  options?: { provider?: string; model?: string }
  session: { header?: { cwd?: string } }
  ctx: { on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown }
  followup(message: HostUserMessage): void
  steer(message: HostUserMessage): void
  inject(message: HostUserMessage): void
}

export interface HostAgentsService {
  get(id: string): HostAgent | undefined
  roots(): HostAgent[]
  /** Present only when an agent-loop plugin is loaded — always feature-detect (HOST-API §6). */
  create?(options: unknown): Promise<unknown>
}

/** HOST-API §1: the cordis context a plugin `apply()` receives. */
export interface HostContextShape {
  tools: {
    register(definition: ToolDefinition): unknown
    /** HOST-API §2: the registry can answer whether a name is mounted (the
     * global view when no scope is given). Absent on a reduced host — always
     * feature-detect before use. */
    get?(name: string): unknown
  }
  settings: HostSettingsService
  agents: HostAgentsService
  /** Web-only; absent in non-web profiles. */
  connection?: HostConnectionHandle
  get(name: string): unknown
  inject(services: string[], callback: (ctx: HostContextShape) => void): unknown
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown
  effect(callback: () => (() => unknown) | void, label?: string): () => unknown
}

/** Identity helper so tool literals get checked against the shape above. */
export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition
}

/** Model-facing text block. */
export function text(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** Object output schema (host-supported subset). */
export const JSON_OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const

/**
 * Register a tool without letting a name collision break the boot: the host
 * registry throws on duplicates (HOST-API §2/§10), so every registration goes
 * through here and reports instead of propagating (P3/P4).
 */
export function registerToolSafe(
  ctx: HostContextShape,
  definition: ToolDefinition,
): { name: string; ok: boolean; error?: string } {
  try {
    ctx.tools.register(definition)
    return { name: definition.name, ok: true }
  } catch (error) {
    return { name: definition.name, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Hand one module's teardown to the host's OWN ownership (F10): `ctx.effect`
 * unwinds with the plugin's fiber, so a superseded boot releases what it owned
 * instead of leaving it to the process lifetime. There is no lifecycle layer
 * here — just the host call, wrapped for the same reason `registerToolSafe` is:
 * a host without `effect` must cost a warning, not a boot.
 */
export function registerLifecycle(
  ctx: HostContextShape,
  release: () => void,
  label: string,
  warn?: (message: string) => void,
): void {
  try {
    const effect = ctx.effect
    if (typeof effect !== 'function') return
    effect.call(ctx, () => release, label)
  } catch (error) {
    warn?.(`${label}: lifecycle registration refused: ${error instanceof Error ? error.message : String(error)}`)
  }
}
