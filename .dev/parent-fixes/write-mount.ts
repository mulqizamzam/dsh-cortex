// PARENT PATCH (apply at wave-1 integration) — write-channel mount.
// REALITY CHECK 12:06 (parent): restored layout HAS NO src/host/rpc.ts — the read
// channel is inlined in src/host/index.ts (:107-123, ctx.inject block). So apply
// THIS FILE as a new src/host/rpc.ts module is WRONG; instead:
//  (a) copy makeCortexEndpointDispatcher into src/host/rpc.ts NEW file (fine),
//      or simpler: inline a second connection.rpc.handle(CORTEX_WRITE_CHANNEL, ...)
//      inside the SAME inject callback in index.ts, with dispatcher logic mirrored
//      from the existing read handler (never-throw envelope, unknown-endpoint).
//  (b) endpoint collection: after the MODULES loop, scan wired modules for
//      optional `readEndpoints`/`writeEndpoints` objects (cast; see module
//      exemplars), merge into two maps with dup-name warnings, and have BOTH
//      inline handlers consult (...Endpoints[endpoint] ?? static ping).
// The RpcDeps shape below already matches index.ts deps (config/store/version).

/** Dispatcher over a module-supplied endpoint map. Handlers must return plain
 * JSON values and throw only Error(message); this wrapper never throws. */
export function makeCortexEndpointDispatcher(
  side: 'read' | 'write',
  deps: RpcDeps,
  getEndpoints: () => Record<string, (payload: any, deps: RpcDeps) => Promise<unknown>>,
) {
  return async (endpoint: string, payload: unknown): Promise<CortexRpcResult<unknown>> => {
    try {
      const handler = getEndpoints()[endpoint]
      if (handler === undefined) {
        return { ok: false, error: { code: 'unknown-endpoint', message: `unknown cortex ${side} endpoint: ${String(endpoint)}` } }
      }
      return { ok: true, value: await handler(payload, deps) }
    } catch (error) {
      return { ok: false, error: { message: errorMessage(error) } }
    }
  }
}

export function registerCortexWriteRpc(
  connection: { rpc?: { handle(channel: string, handler: unknown, options: { authority: string }): unknown } },
  deps: RpcDeps,
  getEndpoints: () => Record<string, (payload: any, deps: RpcDeps) => Promise<unknown>>,
): () => void {
  const log = makeLogger('dsh-cortex:rpc')
  const handler = makeCortexEndpointDispatcher('write', deps, getEndpoints)
  try {
    const disposer = connection.rpc?.handle(CORTEX_WRITE_CHANNEL, handler, { authority: 'loopback' })
    log.info(`channel ${CORTEX_WRITE_CHANNEL} mounted`)
    return typeof disposer === 'function' ? () => { void (disposer as () => unknown)() } : () => {}
  } catch (error) {
    log.warn(`channel ${CORTEX_WRITE_CHANNEL} not mounted: ${errorMessage(error)}`)
    return () => {}
  }
}

// --------------------------------------------------------------- index.ts side (same integration edit):
// 1. import { CORTEX_WRITE_CHANNEL } from './rpc-channels.ts' + registerCortexWriteRpc + makeCortexEndpointDispatcher
//    (reuse for READ too: refactor registerCortexReadRpc's handler to
//     makeCortexEndpointDispatcher('read', deps, () => staticReadEndpoints) — optional, do if trivial).
// 2. In boot(), after modules loop:
//      const writeEndpoints: Record<string, (p:any,d:RpcDeps)=>Promise<unknown>> = {}
//      const readExtra:    Record<string, (p:any,d:RpcDeps)=>Promise<unknown>> = {}
//      for (const m of wiredModules) {  // wire loop must keep module refs
//        const wm = m as { readEndpoints?: ..., writeEndpoints?: ... }
//        for (const [k,h] of Object.entries(wm.readEndpoints ?? {}))   readExtra[k]  = h
//        for (const [k,h] of Object.entries(wm.writeEndpoints ?? {}))  writeEndpoints[k] = h
//      }  // last-writer-wins + log.warn on duplicate key names ('cortex:' + side)
// 3. In the ctx.inject(['connection']) callback after registerCortexReadRpc:
//      registerCortexWriteRpc(connection, { config: readConfig, store, version: () => VERSION }, () => writeEndpoints)
//    and pass readExtra into the read dispatcher (merge static ping + module maps).
// 4. rpc-channels.ts: add CORTEX_WRITE_ENDPOINTS registry entries per module (types only; not enforced).
// DESTRUCTIVE gate (memory.delete / prompts.delete / jobs.cancel / purge.exec): handlers themselves
// require payload.confirm === 'DELETE' | 'DELETE-CORTEX-DATA' (contract RPC-ENDPOINTS.md) — the
// transport stays dumb. No separate capability token (DESIGN §9 OQ-2 ruling, loopback authority).
