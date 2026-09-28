/**
 * M3 · todo module face (DISPATCH integration rule): exports
 * `{ name, TOOLS, apply, readEndpoints, writeEndpoints }`.
 *
 * The digest is injected through its OWN `systemPrompt.context`
 * (`'cortex:todo'`, order 41) — the round-12 ruling keeps the M3 block
 * separate from the M2 memory block, so neither module imports the other and a
 * failure in one cannot take the other's context down.
 *
 * The module never registers an RPC channel: the parent merges the exported
 * endpoint maps into the two loopback-fenced channels (`docs/HOST-API.md` §5).
 */
import { registerLifecycle, registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { TodoService } from './service.ts'
import { todoTools } from './tools.ts'
import type { EndpointHandler } from './rpc.ts'
import { todoReadEndpoints, todoWriteEndpoints } from './rpc.ts'
import { refuse } from '../../rpc-error.ts'

export const name = 'todo'
export const TOOLS = ['cortex_todo_add', 'cortex_todo_list', 'cortex_todo_complete', 'cortex_todo_remove'] as const

export { TODO_CONTEXT_NAME, TODO_CONTEXT_ORDER, renderTodoDigest, orderForDigest, parseDue, isOverdue } from './digest.ts'
export { TodoService, todoReadEndpoints, todoWriteEndpoints }

let service: TodoService | null = null

/** The live service after `apply` (tests, status reporting, integration). */
export function getTodoService(): TodoService | null {
  return service
}

/**
 * Endpoint maps keyed by the frozen contract names. They route through the
 * live service; before `apply` succeeds (or after a failed boot) every call
 * answers honestly instead of throwing at the transport.
 */
const route = (kind: 'read' | 'write', endpoint: string): EndpointHandler =>
  async (payload: unknown) => {
    if (service === null) return refuse(`todo endpoints are not wired (${kind} channel)`, 'not-wired')
    const map = kind === 'read' ? todoReadEndpoints(service) : todoWriteEndpoints(service)
    const handler = map[endpoint]
    if (handler === undefined) return refuse(`unknown todo ${kind} endpoint: ${String(endpoint)}`, 'unknown-endpoint')
    try {
      return await handler(payload)
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error), 'handler-failed')
    }
  }

export const readEndpoints: Record<string, EndpointHandler> = { 'todo.list': route('read', 'todo.list') }
export const writeEndpoints: Record<string, EndpointHandler> = {
  'todo.add': route('write', 'todo.add'),
  'todo.complete': route('write', 'todo.complete'),
  'todo.remove': route('write', 'todo.remove'),
}

export function apply(deps: ModuleDeps): void {
  const svc = new TodoService({ deps })
  service = svc
  // F10: the host's own ownership releases this instance when the plugin's fiber
  // unwinds — the listener and the digest seam go with it, and the endpoints fall
  // back to an honest `not-wired` instead of serving a superseded service.
  // Identity-guarded: a late release of an already-superseded instance must not
  // clear the live one.
  registerLifecycle(deps.ctx, () => {
    if (service !== svc) return
    service = null
    svc.dispose()
  }, 'dsh-cortex:todo service', deps.warn)
  // Context registration first: a refused tool must not cost the session its
  // digest, and vice versa (P4 keeps the two independent).
  svc.install()
  let refused = 0
  const failures: string[] = []
  for (const definition of todoTools(svc)) {
    const registered = registerToolSafe(deps.ctx, definition)
    if (!registered.ok) {
      refused += 1
      failures.push(`${registered.name}: ${registered.error ?? 'unknown'}`)
      deps.warn(`todo: registration refused: ${failures[failures.length - 1]}`)
    }
  }
  // A module with neither its tools nor its injection seam is broken, not
  // degraded: say so, so `cortex_status` reports it as failed instead of ok.
  if (refused === TOOLS.length && !svc.hasContextSeam) {
    throw new Error(`todo: no tool registered and no context seam (${failures.join('; ')})`)
  }
  deps.log(`todo: ready (seam=${String(svc.hasContextSeam)}, tools=${String(TOOLS.length - refused)}/${String(TOOLS.length)}, budget=${String(deps.cfg().caps.todoDigestChars)})`)
}
