/**
 * E2E: a handler that THROWS still produces an envelope the host can parse.
 *
 * The host validates every failure with `rpcErrorSchema`, which requires `code`,
 * `message` AND `details` — all three. The dispatcher's catch built
 * `{ ok:false, error:{ message } }` by hand, so the host rejected the reply and
 * substituted a generic transport error: the real message died on the wire and
 * `pluginErrorCode()` lost the plugin code the panel branches on.
 *
 * The throwing endpoint is registered as a real module in `MODULES`, so this
 * goes through `apply()` and the actual channel dispatcher — no patched seam.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MODULES, apply } from '../../src/host/index.ts'
import { CORTEX_READ_CHANNEL } from '../../src/host/rpc-channels.ts'
import type { ToolDefinition } from '../../src/host/dsh.ts'

/** The host's `rpcErrorSchema`, mirrored: all three members required. */
function hostAccepts(error: unknown): { ok: true } | { ok: false; why: string } {
  if (error === null || typeof error !== 'object') return { ok: false, why: 'error is not an object' }
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown }
  if (typeof candidate.code !== 'string') return { ok: false, why: `code -> expected string, received ${typeof candidate.code}` }
  if (typeof candidate.message !== 'string') return { ok: false, why: `message -> expected string, received ${typeof candidate.message}` }
  if (candidate.details === null || typeof candidate.details !== 'object' || Array.isArray(candidate.details)) {
    return { ok: false, why: `details -> expected record, received ${Array.isArray(candidate.details) ? 'array' : typeof candidate.details}` }
  }
  return { ok: true }
}

const BOOM = {
  name: 'e2e-boom',
  apply: () => {},
  readEndpoints: { 'e2e.boom': async (): Promise<never> => { throw new Error('endpoint exploded') } },
}

let root = ''
const rpcHandlers = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-e2e-rpc-'))
  MODULES.push(BOOM as never)
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void { tools.set(definition.name, definition); return () => {} },
      get: (name: string) => tools.get(name),
    },
    agents: { get: () => undefined, roots: () => [] },
    get(name: string) {
      if (name === 'dshHomePath') return (...segments: string[]) => join(root, ...segments)
      return undefined
    },
    inject: (services: string[], callback: (context: unknown) => void) => {
      if (services.includes('connection')) {
        (ctx as { connection?: unknown }).connection = {
          rpc: {
            handle(channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>): () => void {
              rpcHandlers.set(channel, handler)
              return () => { rpcHandlers.delete(channel) }
            },
          },
        }
      }
      callback(ctx)
    },
    on: () => () => {},
    effect: (callback: () => unknown) => { callback(); return () => {} },
  } as never
  apply(ctx, { stateRoot: root } as never)
})

afterAll(async () => {
  const index = MODULES.indexOf(BOOM as never)
  if (index >= 0) MODULES.splice(index, 1)
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('E2E: a throwing endpoint answers with a host-valid envelope', () => {
  it('carries code, message and details, and keeps the real message', async () => {
    const channel = rpcHandlers.get(CORTEX_READ_CHANNEL)
    expect(channel, 'the read channel must be registered by apply()').toBeDefined()
    const reply = await channel?.('e2e.boom', {}) as { ok?: boolean; error?: unknown } | undefined
    const verdict = hostAccepts(reply?.error)
    console.log(`E2E ENVELOPE ok=${String(reply?.ok)} verdict=${verdict.ok ? 'accepted' : verdict.why}`)
    expect(verdict.ok ? 'accepted' : verdict.why).toBe('accepted')
    expect(String((reply?.error as { message?: string } | undefined)?.message)).toContain('endpoint exploded')
  })
})
