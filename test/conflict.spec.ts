/**
 * Conflict detection module: declare / check / release / expiry contract.
 *
 * Pure in-memory service tests — no host wiring required.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import { CortexStore } from '../src/host/store.ts'
import { conflictService, resetConflictService } from '../src/host/modules/conflict/service.ts'
import type { ModuleDeps } from '../src/host/types.ts'

let root: string
let deps: ModuleDeps
let svc: ReturnType<typeof conflictService>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-conflict-'))
  const store = new CortexStore({ root })
  const cfg = resolveConfig({})
  deps = {
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
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

// ------------------------------------------------------------------ declare

describe('declare', () => {
  it('creates a claim and returns its id + path', () => {
    const result = svc.declare({
      roomId: 'room-a',
      path: join(root, 'projects', 'p1', 'src', 'main.ts'),
      description: 'editing main',
      sessionId: 'session-1',
    })
    expect(result.ok).toBe(true)
    expect(result.claim).toBeDefined()
    expect(result.claim!.id).toMatch(/^c-/)
    expect(result.claim!.sessionId).toBe('session-1')
    expect(result.claim!.path).toBe(join(root, 'projects', 'p1', 'src', 'main.ts'))
    expect(result.conflicts).toBeUndefined()
  })

  it('rejects relative paths', () => {
    const result = svc.declare({ roomId: 'room-a', path: 'src/main.ts', sessionId: 'session-1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('absolute')
  })

  it('rejects paths outside the state root', () => {
    const result = svc.declare({ roomId: 'room-a', path: '/etc/passwd', sessionId: 'session-1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('outside')
  })

  it('rejects empty roomId', () => {
    expect(svc.declare({ roomId: '', path: join(root, 'a.ts'), sessionId: 's1' }).ok).toBe(false)
  })

  it('rejects empty sessionId', () => {
    expect(svc.declare({ roomId: 'r', path: join(root, 'a.ts'), sessionId: '' }).ok).toBe(false)
  })

  it('returns description truncated to 120 chars', () => {
    const longDesc = 'x'.repeat(200)
    const result = svc.declare({ roomId: 'r', path: join(root, 'a.ts'), sessionId: 's1', description: longDesc })
    expect(result.ok).toBe(true)
    expect(result.claim!.description.length).toBeLessThanOrEqual(120)
  })
})

// ------------------------------------------------------------- conflict detection

describe('conflict detection', () => {
  it('flags another session claiming the same path', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-1' })
    const result = svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-2' })
    expect(result.ok).toBe(true)
    expect(result.conflicts).toBeDefined()
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts![0].sessionId).toBe('session-1')
  })

  it('does NOT flag same-session re-declaration', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-1' })
    const result = svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-1' })
    expect(result.ok).toBe(true)
    expect(result.conflicts).toBeUndefined()
  })

  it('different paths in the same room do not conflict', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-1' })
    const result = svc.declare({ roomId: 'room-a', path: join(root, 'b.ts'), sessionId: 'session-2' })
    expect(result.ok).toBe(true)
    expect(result.conflicts).toBeUndefined()
  })

  it('same path in different rooms does not conflict', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-1' })
    const result = svc.declare({ roomId: 'room-b', path: join(root, 'shared.ts'), sessionId: 'session-2' })
    expect(result.ok).toBe(true)
    expect(result.conflicts).toBeUndefined()
  })

  it('normalizes path variants to the same absolute path', () => {
    const norm = join(root, 'projects', 'p1', 'src', 'main.ts')
    const withDot = join(root, 'projects', 'p1', 'src', '.', 'main.ts')
    svc.declare({ roomId: 'room-a', path: norm, sessionId: 'session-1' })
    const result = svc.declare({ roomId: 'room-a', path: withDot, sessionId: 'session-2' })
    expect(result.conflicts).toBeDefined()
    expect(result.conflicts).toHaveLength(1)
  })

  it('allows multiple sessions on the same path in the same room (all see each other)', () => {
    const r1 = svc.declare({ roomId: 'room-a', path: join(root, 'hot.ts'), sessionId: 's1' })
    const r2 = svc.declare({ roomId: 'room-a', path: join(root, 'hot.ts'), sessionId: 's2' })
    const r3 = svc.declare({ roomId: 'room-a', path: join(root, 'hot.ts'), sessionId: 's3' })
    expect(r1.conflicts).toBeUndefined()
    expect(r2.conflicts).toHaveLength(1)
    expect(r3.conflicts).toHaveLength(2)
  })
})

// ------------------------------------------------------------------- check

describe('check', () => {
  it('returns no conflict when path is free', () => {
    const result = svc.check({ roomId: 'room-a', path: join(root, 'free.ts') })
    expect(result.ok).toBe(true)
    expect(result.result!.hasConflict).toBe(false)
    expect(result.result!.conflicts).toHaveLength(0)
  })

  it('returns conflict details when path is claimed', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'busy.ts'), sessionId: 'session-1' })
    const result = svc.check({ roomId: 'room-a', path: join(root, 'busy.ts'), sessionId: 'session-2' })
    expect(result.ok).toBe(true)
    expect(result.result!.hasConflict).toBe(true)
    expect(result.result!.conflicts).toHaveLength(1)
    expect(result.result!.conflicts![0].sessionId).toBe('session-1')
  })

  it('excludes caller from its own conflict list', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'busy.ts'), sessionId: 'session-1' })
    const result = svc.check({ roomId: 'room-a', path: join(root, 'busy.ts'), sessionId: 'session-1' })
    expect(result.result!.hasConflict).toBe(false)
    expect(result.result!.ownClaimId).toMatch(/^c-/)
  })

  it('lists all conflicting claims when path is omitted', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-1' })
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-2' })
    const result = svc.check({ roomId: 'room-a' })
    expect(result.ok).toBe(true)
    expect(result.allConflicts).toBeDefined()
    expect(result.allConflicts).toHaveLength(2)
  })

  it('returns empty when room has no claims', () => {
    const result = svc.check({ roomId: 'empty-room' })
    expect(result.ok).toBe(true)
    expect(result.result!.hasConflict).toBe(false)
  })
})

// ------------------------------------------------------------------ release

describe('release', () => {
  it('removes the claim and clears the conflict for others', () => {
    const r1 = svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-1' })
    const r2 = svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-2' })
    expect(r2.conflicts).toHaveLength(1)

    const released = svc.release(r1.claim!.id)
    expect(released.ok).toBe(true)

    const check = svc.check({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-2' })
    expect(check.result!.hasConflict).toBe(false)
    expect(check.result!.ownClaimId).toBe(r2.claim!.id)
  })

  it('rejects unknown claim ids', () => {
    const result = svc.release('nonexistent-id')
    expect(result.ok).toBe(false)
  })

  it('allows re-declaration after release', () => {
    const r1 = svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-1' })
    svc.release(r1.claim!.id)
    const r2 = svc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'session-2' })
    expect(r2.ok).toBe(true)
    expect(r2.conflicts).toBeUndefined()
  })
})

// ------------------------------------------------------------------- expiry

describe('TTL expiry', () => {
  it('expires claims after ttlSeconds', () => {
    svc.declare({
      roomId: 'room-a',
      path: join(root, 'timed.ts'),
      sessionId: 'session-1',
      ttlSeconds: 1,
    })
    // Still active immediately after declare.
    let check = svc.check({ roomId: 'room-a', path: join(root, 'timed.ts') })
    expect(check.result!.hasConflict).toBe(true)

    // Manually patch declaredAt to be old.
    const claims = svc.listClaims('room-a')
    expect(claims).toHaveLength(1)
    const roomClaims = svc['claims'].get('room-a')
    const pathClaims = roomClaims?.get(claims[0]!.path)
    if (pathClaims) {
      const oldClaim = pathClaims.get('session-1')
      if (oldClaim) {
        pathClaims.set('session-1', { ...oldClaim, declaredAt: new Date(Date.now() - 2000).toISOString() })
      }
    }

    const expired = svc.expireClaims()
    expect(expired).toHaveLength(1)

    check = svc.check({ roomId: 'room-a', path: join(root, 'timed.ts') })
    expect(check.result!.hasConflict).toBe(false)
  })

  it('never expires when ttlSeconds is 0', () => {
    svc.declare({
      roomId: 'room-a',
      path: join(root, 'permanent.ts'),
      sessionId: 'session-1',
      ttlSeconds: 0,
    })
    const expired = svc.expireClaims()
    expect(expired).toHaveLength(0)
    const check = svc.check({ roomId: 'room-a', path: join(root, 'permanent.ts') })
    expect(check.result!.hasConflict).toBe(true)
  })
})

// ------------------------------------------------------------------ listClaims

describe('listClaims', () => {
  it('returns all active claims', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-1' })
    svc.declare({ roomId: 'room-a', path: join(root, 'b.ts'), sessionId: 'session-2' })
    const claims = svc.listClaims('room-a')
    expect(claims).toHaveLength(2)
  })

  it('filters by roomId when given', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-1' })
    svc.declare({ roomId: 'room-b', path: join(root, 'b.ts'), sessionId: 'session-2' })
    const claimsA = svc.listClaims('room-a')
    const claimsB = svc.listClaims('room-b')
    expect(claimsA).toHaveLength(1)
    expect(claimsB).toHaveLength(1)
    expect(claimsA[0]!.sessionId).toBe('session-1')
    expect(claimsB[0]!.sessionId).toBe('session-2')
  })

  it('returns all claims when roomId is omitted', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-1' })
    svc.declare({ roomId: 'room-b', path: join(root, 'b.ts'), sessionId: 'session-2' })
    const all = svc.listClaims()
    expect(all).toHaveLength(2)
  })
})

// ------------------------------------------------------------------- size

describe('size', () => {
  it('reports correct count', () => {
    expect(svc.size()).toBe(0)
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-1' })
    expect(svc.size()).toBe(1)
    svc.declare({ roomId: 'room-a', path: join(root, 'b.ts'), sessionId: 'session-2' })
    expect(svc.size()).toBe(2)
  })
})

// ------------------------------------------------------------------- clear

describe('clear', () => {
  it('removes all state', () => {
    svc.declare({ roomId: 'room-a', path: join(root, 'a.ts'), sessionId: 'session-1' })
    svc.clear()
    expect(svc.size()).toBe(0)
    const check = svc.check({ roomId: 'room-a', path: join(root, 'a.ts') })
    expect(check.result!.hasConflict).toBe(false)
  })
})

// --------------------------------------------------------------- integration

describe('integration: full declare → check → release flow', () => {
  it('flows correctly end-to-end', () => {
    // Session 1 declares.
    const d1 = svc.declare({ roomId: 'room-x', path: join(root, 'app.ts'), sessionId: 's1', description: 'editing app' })
    expect(d1.ok).toBe(true)
    expect(d1.claim?.id).toBeDefined()

    // Session 2 checks and sees conflict.
    const c2 = svc.check({ roomId: 'room-x', path: join(root, 'app.ts'), sessionId: 's2' })
    expect(c2.result!.hasConflict).toBe(true)
    expect(c2.result!.conflicts).toHaveLength(1)
    expect(c2.result!.conflicts![0].sessionId).toBe('s1')

    // Session 2 also declares (should see the conflict in response).
    const d2 = svc.declare({ roomId: 'room-x', path: join(root, 'app.ts'), sessionId: 's2', description: 'also editing' })
    expect(d2.conflicts).toHaveLength(1)

    // Session 1 releases.
    const r1 = svc.release(d1.claim!.id)
    expect(r1.ok).toBe(true)

    // Session 2 now sees no conflict (but still has its own claim).
    const c2again = svc.check({ roomId: 'room-x', path: join(root, 'app.ts'), sessionId: 's2' })
    expect(c2again.result!.hasConflict).toBe(false)
    expect(c2again.result!.ownClaimId).toBe(d2.claim?.id)
  })
})
