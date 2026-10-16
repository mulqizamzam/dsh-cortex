/**
 * Every `ok:false` reply must survive the HOST's validator.
 *
 * The host parses each reply with `rpcErrorSchema` (zod) — mirrored below — and
 * that schema requires `code`, `message` AND `details` on every failure. The
 * plugin's own doc already said so ("Omitting it makes the whole reply
 * unparseable"), but `RpcResult` declared `code?`/`details?` optional, so four
 * hand-built envelopes slipped through the type:
 *
 *   - src/host/index.ts        the dispatcher's catch
 *   - src/host/index.ts        pending.list
 *   - modules/delegate/rpc.ts  the not-wired answer
 *   - modules/memory/endpoints the shared rpcFail() — i.e. EVERY memory refusal
 *
 * The host rejected those and substituted a generic transport error, so the
 * panel lost the real message and `pluginErrorCode()` lost the plugin code the
 * "not mounted" and settings-health branches read.
 *
 * The durable guard is the type itself now (making `code` and `details`
 * required turned each of those four into a compile error, and immediately
 * surfaced a fourth site a manual audit had missed). This spec pins the runtime
 * half: a real endpoint refusal, driven through real deps, still validates.
 */
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeEndpoints } from '../src/host/modules/memory/endpoints.ts'
import { pluginErrorCode } from '../src/client/api.ts'
import { refuse } from '../src/host/rpc-error.ts'
import { makeHarness } from './memory/fixture.ts'
import type { Harness } from './memory/fixture.ts'

/**
 * The host's `rpcErrorSchema`, mirrored: all three members REQUIRED. Kept
 * hand-rolled on purpose — adding a test-only dependency to validate a wire
 * contract would be a worse trade than ten lines.
 */
interface WireError { code: string; message: string; details: Record<string, unknown> }

function hostAccepts(error: unknown): { ok: true } | { ok: false; why: string } {
  if (error === null || typeof error !== 'object') return { ok: false, why: 'error is not an object' }
  const candidate = error as Partial<WireError>
  if (typeof candidate.code !== 'string') return { ok: false, why: `code -> expected string, received ${typeof candidate.code}` }
  if (typeof candidate.message !== 'string') return { ok: false, why: `message -> expected string, received ${typeof candidate.message}` }
  if (candidate.details === null || typeof candidate.details !== 'object' || Array.isArray(candidate.details)) {
    return { ok: false, why: `details -> expected record, received ${Array.isArray(candidate.details) ? 'array' : typeof candidate.details}` }
  }
  return { ok: true }
}

let harness: Harness

beforeEach(async () => { harness = await makeHarness() })
afterEach(async () => { await rm(harness.root, { recursive: true, force: true }).catch(() => {}) })

/** Drive one real endpoint to a real refusal and hand back its envelope. */
async function refusalOf(endpoint: keyof typeof writeEndpoints, payload: unknown): Promise<WireError> {
  const handler = writeEndpoints[endpoint]
  if (handler === undefined) throw new Error(`no such endpoint: ${String(endpoint)}`)
  const result = await handler(payload, harness.deps)
  if (result.ok) throw new Error(`${String(endpoint)} unexpectedly succeeded`)
  return result.error as WireError
}

describe('failure envelopes survive the host validator', () => {
  it('a real endpoint refusal carries code, message and details', async () => {
    const error = await refusalOf('memory.archive', { id: 'does-not-exist' })
    const verdict = hostAccepts(error)
    expect(verdict.ok ? 'accepted' : verdict.why).toBe('accepted')
    expect(typeof error.code).toBe('string')
    expect(error.message).not.toBe('')
    // The client still has to be able to recover OUR code after the projection.
    expect(pluginErrorCode({ code: error.code, message: error.message })).not.toBe('')
  })

  it('every refusing memory endpoint is deliverable', async () => {
    // `memory.delete` is deliberately absent: it is idempotent and answers ok for
    // an unknown id, so it cannot reach the failure arm.
    const cases: Array<[keyof typeof writeEndpoints, unknown]> = [
      ['memory.archive', { id: 'does-not-exist' }],
      ['memory.restore', { id: 'does-not-exist' }],
      ['memory.update', { id: 'does-not-exist', patch: { content: 'x' } }],
      ['pending.approve', { id: 'does-not-exist' }],
      ['pending.reject', { id: 'does-not-exist' }],
    ]
    let refusals = 0
    for (const [endpoint, payload] of cases) {
      const handler = writeEndpoints[endpoint]
      if (handler === undefined) throw new Error(`no such endpoint: ${String(endpoint)}`)
      const result = await handler(payload, harness.deps)
      if (result.ok) continue
      refusals += 1
      const verdict = hostAccepts(result.error)
      expect(`${String(endpoint)}: ${verdict.ok ? 'accepted' : verdict.why}`).toBe(`${String(endpoint)}: accepted`)
    }
    // Guards against the loop passing because nothing refused at all.
    expect(refusals).toBeGreaterThan(0)
  })

  it('the dispatcher-level helper is deliverable, which is what the other sites use', async () => {
    // index.ts (dispatcher catch, pending.list), delegate/rpc.ts (not-wired) and
    // memory/endpoints.ts (rpcFail) all build their failures with `refuse` now.
    const refusal = refuse('endpoint exploded', 'handler-failed')
    if (refusal.ok) throw new Error('unreachable')
    const verdict = hostAccepts(refusal.error)
    expect(verdict.ok ? 'accepted' : verdict.why).toBe('accepted')
    expect(pluginErrorCode(refusal.error)).toBe('handler-failed')
  })
})
