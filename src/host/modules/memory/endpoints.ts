/**
 * The RPC endpoint maps for `/dsh-cortex-read` and `/dsh-cortex-write`, named
 * exactly as `.dev/RPC-ENDPOINTS.md` freezes them. Names and payload keys are
 * the contract; the parent wires the channels (this module never calls
 * `connection.rpc.handle`).
 *
 * Handlers: `(payload, deps) => Promise<RpcResult>`. They validate their own
 * arguments by hand, never throw, and never leak a stack — a transport error
 * would be a bare message to the browser anyway (P4/P7).
 *
 * Shape note for M7: `memory.list` / `memory.search` resolve to an OBJECT that
 * carries the frozen row arrays plus the honesty flags
 * (`{ entries, truncated, branch }`, `{ hits, candidates, … }`), because a bare
 * array cannot say "the store stopped reading at 500" (P2, M0-NOTES §6.9).
 */
import { errorMessage } from '../../../lib/errors.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import type { RpcResult } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { approvePendingMemory, deleteEntry, listEntries, moveEntry, ok, rejectPending, search, updateEntry } from './ops.ts'
import type { OpResult } from './ops.ts'
import { contextFor, invalidateInjector } from './runtime.ts'

/** One RPC handler, as the parent's dispatch table expects it. */
export type MemoryEndpoint = (payload: unknown, deps: ModuleDeps) => Promise<RpcResult<unknown>>

function rpcOk<T>(value: T): RpcResult<T> {
  return { ok: true, value: neutralizeDeep(value) }
}

function rpcFail(error: string, code?: string): RpcResult<never> {
  return { ok: false, error: { message: neutralize(error), ...(code === undefined ? {} : { code }) } }
}

function fromOp<T>(result: OpResult<T>): RpcResult<T> {
  return result.ok === true ? rpcOk(result.value) : rpcFail(result.error, result.code)
}

function payloadOf(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

/** Every handler body runs through this: op + never-throw + cache invalidation. */
async function endpoint(
  label: string,
  deps: ModuleDeps,
  body: () => Promise<OpResult<unknown>>,
  options: { writes?: boolean } = {},
): Promise<RpcResult<unknown>> {
  try {
    const result = await body()
    if (result.ok === true && options.writes === true) invalidateInjector(deps.ctx)
    return fromOp(result)
  } catch (error) {
    deps.warn(neutralize(`${label} endpoint failed: ${errorMessage(error)}`))
    return rpcFail(`${label} failed: ${errorMessage(error)}`, 'internal')
  }
}

/** `branch` in the payload is explicit; absent means "use the live branch". */
function branchArg(payload: Record<string, unknown>): { branch?: string | null } {
  if (!('branch' in payload)) return {}
  const value = payload.branch
  if (value === null) return { branch: null }
  if (typeof value === 'string') return { branch: value.trim() }
  return { branch: null }
}

/** The read endpoints, keyed by their frozen names. */
export const readEndpoints: Record<string, MemoryEndpoint> = {
  'memory.list': (payload, deps) => endpoint('memory.list', deps, async () => {
    const input = payloadOf(payload)
    const result = await listEntries(contextFor(deps), { ...input, ...branchArg(input) })
    if (result.ok === false) return result
    return ok({
      entries: result.value.entries,
      truncated: result.value.truncated,
      branch: result.value.branch,
      ...(result.value.pid === undefined ? {} : { pid: result.value.pid }),
    })
  }),

  'memory.search': (payload, deps) => endpoint('memory.search', deps, async () => {
    const input = payloadOf(payload)
    const result = await search(contextFor(deps), input)
    if (result.ok === false) return result
    return ok({
      hits: result.value.hits,
      candidates: result.value.candidates,
      shown: result.value.shown,
      omitted: result.value.omitted,
      listingTruncated: result.value.listingTruncated,
      text: result.value.text,
    })
  }),
}

/** The write endpoints, keyed by their frozen names. */
export const writeEndpoints: Record<string, MemoryEndpoint> = {
  'memory.update': (payload, deps) => endpoint('memory.update', deps, async () => {
    const input = payloadOf(payload)
    // The contract nests the change: {id, patch{...}}. A flat body is accepted
    // too, because a UI that flattens it must not silently change nothing.
    const patch = payloadOf(input.patch)
    return updateEntry(contextFor(deps), { ...patch, id: input.id, scope: input.scope })
  }, { writes: true }),

  'memory.archive': (payload, deps) => endpoint('memory.archive', deps, async () => {
    const input = payloadOf(payload)
    return moveEntry(contextFor(deps), input, 'archive')
  }, { writes: true }),

  'memory.restore': (payload, deps) => endpoint('memory.restore', deps, async () => {
    const input = payloadOf(payload)
    return moveEntry(contextFor(deps), input, 'restore')
  }, { writes: true }),

  'memory.delete': (payload, deps) => endpoint('memory.delete', deps, async () => {
    const context = contextFor(deps)
    return deleteEntry(context, payloadOf(payload), context.tokens)
  }, { writes: true }),

  // A pending MEMORY proposal becomes an entry only through this route while
  // memory.autoAccept is off; todo/prompt proposals are refused, not applied.
  'pending.approve': (payload, deps) => endpoint('pending.approve', deps, async () => {
    const input = payloadOf(payload)
    return approvePendingMemory(contextFor(deps), input)
  }, { writes: true }),

  'pending.reject': (payload, deps) => endpoint('pending.reject', deps, async () => {
    const input = payloadOf(payload)
    return rejectPending(contextFor(deps), input)
  }, { writes: true }),
}

/** Ids this module answers on each channel, for the parent's wiring report. */
export const READ_ENDPOINT_NAMES: readonly string[] = Object.keys(readEndpoints)
export const WRITE_ENDPOINT_NAMES: readonly string[] = Object.keys(writeEndpoints)
