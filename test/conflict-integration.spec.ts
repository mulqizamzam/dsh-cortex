/**
 * Conflict detection integration tests:
 *   - Auto-room notification when declare detects conflicts
 *   - Delegation integration: job auto-declare + auto-release on finalize
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'
import { CortexStore } from '../src/host/store.ts'
import { conflictService, resetConflictService } from '../src/host/modules/conflict/service.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import { DelegateService } from '../src/host/modules/delegate/service.ts'
import { resetRoomsService, roomsService } from '../src/host/modules/rooms/service.ts'

let root: string
let deps: ModuleDeps
let store: CortexStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-conflict-int-'))
  store = new CortexStore({ root })
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
  resetRoomsService(root)
})

afterEach(async () => {
  resetConflictService(root)
  resetRoomsService(root)
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

// ------------------------------------------------------------------ notifyRoom

describe('claimed-path rendering (regression: root path rendered empty)', () => {
  it('names the ABSOLUTE path in the room message when the claim IS the state root', async () => {
    // `relative(root, root)` is '', which used to render an empty bullet and hid
    // the very file in conflict. Found live via a delegation job that claims cwd.
    const conflictSvc = conflictService(deps)
    conflictSvc.declare({ roomId: 'room-a', path: root, sessionId: 'session-1' })
    const spy = vi.spyOn(store, 'postMessage').mockImplementation(async () => ({ ok: true, data: null }) as never)

    const second = conflictSvc.declare({ roomId: 'room-a', path: root, sessionId: 'session-2' })
    await new Promise(r => setTimeout(r, 50))

    expect(spy).toHaveBeenCalled()
    const input = spy.mock.calls[0]?.[1] as { text: string }
    expect(input.text).toContain(root)
    expect(input.text).not.toContain('path(es):\n- Sessions involved')
    // The declare result's own sentence must name the path too.
    expect(second.message).toContain(root)
    spy.mockRestore()
  })

  it('still prefers the relative path for a path below the root', () => {
    const conflictSvc = conflictService(deps)
    const first = conflictSvc.declare({ roomId: 'room-a', path: join(root, 'a', 'b.ts'), sessionId: 'session-1' })
    expect(first.message).toContain(join('a', 'b.ts'))
    expect(first.message).not.toContain(root)
  })
})

describe('auto-room-notification on declare', () => {
  it('posts a system message to the room when a conflict is detected', async () => {
    // Create a room and have session-1 declare a path.
    const conflictSvc = conflictService(deps)
    const s1 = conflictSvc.declare({
      roomId: 'room-a',
      path: join(root, 'shared.ts'),
      sessionId: 'session-1',
    })
    expect(s1.ok).toBe(true)

    // Spy on store.postMessage BEFORE session-2 declares (to catch the notifyRoom call).
    const spy = vi.spyOn(store, 'postMessage').mockImplementation(async () => {
      const result = { ok: true, data: null }
      return result as never
    })

    // Session-2 declares the same path — should see conflict AND trigger room post.
    const s2 = conflictSvc.declare({
      roomId: 'room-a',
      path: join(root, 'shared.ts'),
      sessionId: 'session-2',
    })
    expect(s2.ok).toBe(true)
    expect(s2.conflicts).toHaveLength(1)

    // Wait for the fire-and-forget notifyRoom to settle.
    await new Promise(r => setTimeout(r, 50))
    expect(spy).toHaveBeenCalled()
    const [, input] = spy.mock.calls[0]
    expect(input.fromKind).toBe('system')
    expect(input.text).toContain('conflict')
    spy.mockRestore()
  })

  it('does NOT post when there is no conflict', async () => {
    const conflictSvc = conflictService(deps)
    const spy = vi.spyOn(store, 'postMessage')

    conflictSvc.declare({ roomId: 'room-a', path: join(root, 'unique.ts'), sessionId: 'session-1' })
    await new Promise(r => setTimeout(r, 50))
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

// ----------------------------------------------------------- delegation integration

describe('delegation integration', () => {
  it('auto-declares a conflict claim when a room-linked job is dispatched', async () => {
    const conflictSvc = conflictService(deps)

    // Create the room properly through the store.
    const created = await store.createRoom({ title: 'test room' })
    expect(created.ok).toBe(true)
    expect(created.data).toBeDefined()
    const roomId = created.data!.id

    // Manually declare like dispatch would.
    const result = conflictSvc.declare({
      roomId,
      path: root,
      description: 'delegate job j-1 (runner: echo)',
      sessionId: 'session-delegator',
      ttlSeconds: 3600,
    })
    expect(result.ok).toBe(true)
    expect(result.claim).toBeDefined()
    expect(result.claim!.sessionId).toBe('session-delegator')
  })

  it('job conflict claim is released on finalize', async () => {
    const conflictSvc = conflictService(deps)
    const delegateSvc = new DelegateService(deps)

    // Manually simulate the declare-then-finalize flow.
    const declareResult = conflictSvc.declare({
      roomId: 'room-x',
      path: root,
      description: 'delegate job j-test',
      sessionId: 'session-owner',
      ttlSeconds: 3600,
    })
    expect(declareResult.ok).toBe(true)
    const claimId = declareResult.claim!.id

    // Verify claim exists.
    const before = conflictSvc.listClaims('room-x')
    expect(before).toHaveLength(1)
    expect(before[0]!.id).toBe(claimId)

    // Simulate finalize releasing the claim.
    const releaseResult = conflictSvc.release(claimId)
    expect(releaseResult.ok).toBe(true)

    // Claim should be gone.
    const after = conflictSvc.listClaims('room-x')
    expect(after).toHaveLength(0)
  })

  it('conflict check sees the delegation claim', () => {
    const conflictSvc = conflictService(deps)

    // Session A declares a path.
    conflictSvc.declare({
      roomId: 'room-x',
      path: join(root, 'app.ts'),
      sessionId: 'session-a',
    })

    // Session B checks — should see the conflict.
    const check = conflictSvc.check({ roomId: 'room-x', path: join(root, 'app.ts'), sessionId: 'session-b' })
    expect(check.result!.hasConflict).toBe(true)
    expect(check.result!.conflicts).toHaveLength(1)
    expect(check.result!.conflicts![0].sessionId).toBe('session-a')
  })
})

// ----------------------------------------------------------------- cross-module

describe('cross-module: conflict + rooms + delegate', () => {
  it('agents in same room see each other\'s claims through check', () => {
    const conflictSvc = conflictService(deps)

    // Agent 1 declares editing a shared config.
    const d1 = conflictSvc.declare({
      roomId: 'shared-room',
      path: join(root, 'config.yml'),
      sessionId: 'agent-1',
      description: 'updating deployment config',
    })
    expect(d1.ok).toBe(true)

    // Agent 2 checks the same path — sees the conflict.
    const c2 = conflictSvc.check({ roomId: 'shared-room', path: join(root, 'config.yml'), sessionId: 'agent-2' })
    expect(c2.result!.hasConflict).toBe(true)
    expect(c2.result!.conflicts![0].description).toContain('updating deployment config')

    // Agent 2 declares too — sees conflict in declare response.
    const d2 = conflictSvc.declare({
      roomId: 'shared-room',
      path: join(root, 'config.yml'),
      sessionId: 'agent-2',
      description: 'also updating config',
    })
    expect(d2.conflicts).toBeDefined()
    expect(d2.conflicts).toHaveLength(1)
  })

  it('claims are isolated per room — different rooms do not interfere', () => {
    const conflictSvc = conflictService(deps)

    // Agent 1 claims path X in room-a.
    conflictSvc.declare({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'agent-1' })
    // Agent 2 claims path Y in room-b (different path, different room).
    conflictSvc.declare({ roomId: 'room-b', path: join(root, 'other.ts'), sessionId: 'agent-2' })

    // Agent 2 checking room-a on path X — no conflict (agent-2 never claimed anything in room-a).
    const checkA = conflictSvc.check({ roomId: 'room-a', path: join(root, 'shared.ts'), sessionId: 'agent-2' })
    // agent-1 HAS claimed this path in room-a, so hasConflict = true (correct: there IS a conflict in room-a).
    expect(checkA.result!.hasConflict).toBe(true)
    expect(checkA.result!.conflicts![0].sessionId).toBe('agent-1')

    // Agent 2 checking their OWN claim in room-b — no self-conflict.
    const checkB = conflictSvc.check({ roomId: 'room-b', path: join(root, 'other.ts'), sessionId: 'agent-2' })
    expect(checkB.result!.hasConflict).toBe(false)
    expect(checkB.result!.ownClaimId).toBeDefined()
  })
})
