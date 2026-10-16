/**
 * `declare()` decided whether an EXISTING claim had expired by testing the
 * INCOMING declaration's `ttlSeconds` instead of the claim's own — while the very
 * next line of the same predicate used `c.ttlSeconds`. So a claim declared with
 * `ttlSeconds: 0` (never expires) was missed by a later ttl-bearing declaration,
 * and a claim expired hours ago still raised a phantom CONFLICT. `check()`,
 * `listClaims()` and `expireClaims()` all read `claim.ttlSeconds`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import { CortexStore } from '../src/host/store.ts'
import { conflictService, resetConflictService } from '../src/host/modules/conflict/service.ts'
import type { ModuleDeps } from '../src/host/types.ts'

let root = ''
let svc: ReturnType<typeof conflictService>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-conflict-ttl-'))
  const store = new CortexStore({ root })
  const cfg = resolveConfig({})
  const deps: ModuleDeps = {
    store,
    cfg: () => cfg,
    log: () => {},
    warn: () => {},
    runtime: () => ({ modules: [] }),
    ctx: {} as never,
  }
  await store.init()
  resetConflictService(root)
  svc = conflictService(deps)
})

afterEach(async () => {
  resetConflictService(root)
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('declare() judges an existing claim by its own ttl', () => {
  it('raises no conflict for a claim that expired long ago', () => {
    const path = join(root, 'projects', 'p1', 'main.ts')
    svc.declare({ roomId: 'room-a', path, sessionId: 'session-1', ttlSeconds: 10 })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000)

    const second = svc.declare({ roomId: 'room-a', path, sessionId: 'session-2' })
    expect(second.ok).toBe(true)
    expect(second.conflicts ?? []).toHaveLength(0)
  })

  it('raises a conflict for a permanent claim from a ttl-bearing declaration', () => {
    const path = join(root, 'projects', 'p1', 'main.ts')
    svc.declare({ roomId: 'room-a', path, sessionId: 'session-1', ttlSeconds: 0 })

    const second = svc.declare({ roomId: 'room-a', path, sessionId: 'session-2', ttlSeconds: 60 })
    expect(second.ok).toBe(true)
    expect(second.conflicts ?? []).toHaveLength(1)
  })
})
