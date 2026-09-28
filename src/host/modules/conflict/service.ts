/**
 * Conflict detection module — lightweight "heads up" for concurrent file writes.
 *
 * When two agents in the same room both declare an intent to write to the same
 * file path, this module detects the overlap and raises a warning BEFORE either
 * agent commits. This is NOT a two-phase commit; it is a path-matching registry
 * with an explicit declare/check/release contract.
 *
 * Contract:
 *  - An agent calls `cortex_conflict_declare` when it starts working on a file.
 *  - Another agent calls `cortex_conflict_check` (or the system auto-checks)
 *    before starting its own write to see if there is an existing claim.
 *  - On conflict, a warning is posted to the room (if room-linked) and returned
 *    in the check response.
 *  - The declaring agent calls `cortex_conflict_release` when done (or the claim
 *    expires after `conflict.intentTtlSeconds`).
 *
 * In-memory only: no durability guarantees. A host restart clears all claims.
 * This is intentional — the goal is real-time coordination, not audit trail.
 */
import { isAbsolute, join, relative, resolve } from 'node:path'
import { clampText } from '../../../lib/caps.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { HostAgent, ToolDefinition } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { callerSessionId } from '../rooms/service.ts'

// ----------------------------------------------------------------- types --

/** One declared intent to write a file. */
export interface ConflictClaim {
  /** Unique id for this claim (not the session id). */
  id: string
  /** Room id this claim belongs to. */
  roomId: string
  /** Session that declared the intent. */
  sessionId: string
  /** Normalized absolute path being written. */
  path: string
  /** Human-readable description (truncated). */
  description: string
  /** When the claim was created. */
  declaredAt: string
  /** TTL in seconds; 0 = no expiry. */
  ttlSeconds: number
}

/** Result of a conflict check. */
export interface ConflictCheckResult {
  /** True when there are active conflicts on this path. */
  hasConflict: boolean
  /** List of conflicting claims. */
  conflicts: Array<{
    sessionId: string
    description: string
    declaredAt: string
    claimId: string
  }>
  /** The caller's own claim id (if any), so they can release it later. */
  ownClaimId?: string | null
}

/** Raw args shape for tool calls. */
type Args = Record<string, unknown>

// --------------------------------------------------------------- service --

/**
 * In-memory claim store, keyed by (roomId, path) for O(1) lookup.
 * A single process-level instance per state root, cached like RoomService.
 */
export class ConflictService {
  private readonly deps: ModuleDeps
  /** roomId -> Map<path, Map<sessionId, Claim>> — path-level dedup per room. */
  private readonly claims = new Map<string, Map<string, Map<string, ConflictClaim>>>()
  /** id -> claim for direct lookup (release, check). */
  private readonly byId = new Map<string, ConflictClaim>()
  /** Cleanup timer; cleared on dispose. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: ModuleDeps) {
    this.deps = deps
  }

  get root(): string {
    return this.deps.store.root
  }

  private warn(message: string): void {
    this.deps.warn(`conflict: ${message}`)
  }

  // -------------------------------------------------------------- declare --

  /**
   * Declare an intent to write `path`. If a conflicting claim already exists
   * from another session in the same room, the result carries the warning.
   */
  declare(input: {
    roomId: string
    path: string
    description?: string
    sessionId: string
    ttlSeconds?: number
  }): { ok: boolean; message: string; claim?: ConflictClaim; conflicts?: ConflictClaim[] } {
    const { roomId, path, description, sessionId, ttlSeconds = 0 } = input

    // Validate path: must be absolute and inside the state root.
    const abs = resolve(path)
    const root = resolve(this.root)
    if (!isAbsolute(path)) {
      return { ok: false, message: `path must be absolute: ${neutralize(path)}` }
    }
    if (abs !== root && !abs.startsWith(root + '/')) {
      return { ok: false, message: `path ${neutralize(abs)} is outside the state root; only plugin-owned files may be tracked.` }
    }
    if (!isSafeKey(roomId)) {
      return { ok: false, message: `roomId must be a safe id ([A-Za-z0-9_-]{1,64}).` }
    }
    if (sessionId === '') {
      return { ok: false, message: 'sessionId is required.' }
    }

    // Check for existing claims on this (roomId, path).
    const roomClaims = this.claims.get(roomId) ?? new Map()
    const pathClaims = roomClaims.get(abs) ?? new Map()
    const existing = [...pathClaims.values()]

    // Filter out expired claims.
    const now = Date.now()
    const active = existing.filter(c => {
      if (ttlSeconds === 0) return true
      const age = (now - new Date(c.declaredAt).getTime()) / 1000
      return age < c.ttlSeconds
    })

    // Detect conflicts: same path, different session.
    const conflicts = active.filter(c => c.sessionId !== sessionId)

    // Create the new claim.
    const claim: ConflictClaim = {
      id: `c-${crypto.randomUUID()?.replace(/-/g, '').slice(0, 12)}`,
      roomId,
      sessionId,
      path: abs,
      description: clampText(neutralize(description ?? ''), 120),
      declaredAt: new Date().toISOString(),
      ttlSeconds,
    }

    // Store.
    pathClaims.set(sessionId, claim)
    roomClaims.set(abs, pathClaims)
    this.claims.set(roomId, roomClaims)
    this.byId.set(claim.id, claim)

    const relPath = this.displayPath(abs)
    let message = `declared intent to write ${neutralize(relPath)} in ${roomId}`
    if (conflicts.length > 0) {
      message = `${message}; CONFLICT: ${String(conflicts.length)} other session(s) also claiming this path`
      // Auto-flag to orchestrator: post a system message to the room so all
      // members (including the orchestrator) see the heads-up. Fire-and-forget;
      // a post failure never fails the declare (P4: honest, not fatal).
      void this.notifyRoom(roomId, conflicts, sessionId).catch((error: unknown) => {
        this.warn(`room notification failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    return { ok: true, message, claim, conflicts: conflicts.length > 0 ? conflicts : undefined }
  }

  // --------------------------------------------------------------- check --

  /**
   * Check for conflicts on a path (or list all active conflicts in a room).
   */
  check(input: {
    roomId: string
    path?: string
    sessionId?: string
  }): { ok: boolean; message: string; result?: ConflictCheckResult; allConflicts?: ConflictClaim[] } {
    const { roomId, path, sessionId } = input

    if (!isSafeKey(roomId)) {
      return { ok: false, message: `roomId must be a safe id.` }
    }

    // If a specific path is given, check that path.
    if (path !== undefined) {
      const abs = resolve(path)
      const roomClaims = this.claims.get(roomId)
      const pathClaims = roomClaims?.get(abs)
      const allAtPath = pathClaims ? [...pathClaims.values()] : []

      // Filter expired.
      const now = Date.now()
      const active = allAtPath.filter(c => {
        if (c.ttlSeconds === 0) return true
        const age = (now - new Date(c.declaredAt).getTime()) / 1000
        return age < c.ttlSeconds
      })

      const caller = sessionId ?? ''
      const conflicts = active.filter(c => c.sessionId !== caller)
      const ownClaim = active.find(c => c.sessionId === caller)

      const relPath = this.displayPath(abs)
      return {
        ok: true,
        message: conflicts.length > 0
          ? `CONFLICT on ${neutralize(relPath)}: ${String(conflicts.length)} other session(s) have declared intent`
          : `no conflict on ${neutralize(relPath)}`,
        result: {
          hasConflict: conflicts.length > 0,
          conflicts: conflicts.map(c => ({
            sessionId: c.sessionId,
            description: c.description,
            declaredAt: c.declaredAt,
            claimId: c.id,
          })),
          ownClaimId: ownClaim?.id ?? null,
        },
      }
    }

    // No path: return all active conflicts in the room.
    const roomClaims = this.claims.get(roomId)
    if (roomClaims === undefined || roomClaims.size === 0) {
      return { ok: true, message: `no claims in room ${roomId}`, result: { hasConflict: false, conflicts: [] } }
    }

    const now = Date.now()
    const allClaims: ConflictClaim[] = []
    for (const pathMap of roomClaims.values()) {
      for (const claim of pathMap.values()) {
        if (claim.ttlSeconds > 0) {
          const age = (now - new Date(claim.declaredAt).getTime()) / 1000
          if (age >= claim.ttlSeconds) continue
        }
        allClaims.push(claim)
      }
    }

    // Group by path to find actual conflicts (2+ sessions on same path).
    const byPath = new Map<string, ConflictClaim[]>()
    for (const claim of allClaims) {
      const list = byPath.get(claim.path) ?? []
      list.push(claim)
      byPath.set(claim.path, list)
    }

    const conflicts: ConflictClaim[] = []
    for (const [, list] of byPath) {
      if (list.length >= 2) conflicts.push(...list)
    }

    return {
      ok: true,
      message: conflicts.length > 0
        ? `found ${String(conflicts.length)} conflicting claim(s) in room ${roomId}`
        : `no conflicts in room ${roomId} (${allClaims.length} active claim(s))`,
      result: {
        hasConflict: conflicts.length > 0,
        conflicts: conflicts.map(c => ({
          sessionId: c.sessionId,
          description: c.description,
          declaredAt: c.declaredAt,
          claimId: c.id,
        })),
      },
      allConflicts: conflicts.length > 0 ? conflicts : undefined,
    }
  }

  // ---------------------------------------------------------------- release --

  /** Release a declared intent by id. */
  release(claimId: string): { ok: boolean; message: string } {
    const claim = this.byId.get(claimId)
    if (claim === undefined) {
      return { ok: false, message: `no claim found with id ${neutralize(claimId)}` }
    }
    // Remove from path map.
    const roomClaims = this.claims.get(claim.roomId)
    if (roomClaims !== undefined) {
      const pathClaims = roomClaims.get(claim.path)
      if (pathClaims !== undefined) {
        pathClaims.delete(claim.sessionId)
        if (pathClaims.size === 0) roomClaims.delete(claim.path)
      }
      if (roomClaims.size === 0) this.claims.delete(claim.roomId)
    }
    this.byId.delete(claimId)
    return { ok: true, message: `released claim ${neutralize(claimId)} for ${neutralize(claim.path)}` }
  }

  /** Auto-expire claims past TTL, return list of expired ids. */
  expireClaims(): string[] {
    const now = Date.now()
    const expired: string[] = []
    for (const [roomId, roomClaims] of this.claims) {
      for (const [path, pathClaims] of roomClaims) {
        for (const [sessionId, claim] of pathClaims) {
          if (claim.ttlSeconds === 0) continue
          const age = (now - new Date(claim.declaredAt).getTime()) / 1000
          if (age >= claim.ttlSeconds) {
            expired.push(claim.id)
            pathClaims.delete(sessionId)
          }
        }
        if (pathClaims.size === 0) roomClaims.delete(path)
      }
      if (roomClaims.size === 0) this.claims.delete(roomId)
    }
    // Also clean byId.
    for (const id of expired) this.byId.delete(id)
    return expired
  }

  // ----------------------------------------------------------------- list --

  /** List all active claims (for debugging / status). */
  listClaims(roomId?: string): ConflictClaim[] {
    const now = Date.now()
    const result: ConflictClaim[] = []
    for (const [rId, roomClaims] of this.claims) {
      if (roomId !== undefined && rId !== roomId) continue
      for (const [, pathClaims] of roomClaims) {
        for (const claim of pathClaims.values()) {
          if (claim.ttlSeconds > 0) {
            const age = (now - new Date(claim.declaredAt).getTime()) / 1000
            if (age >= claim.ttlSeconds) continue
          }
          result.push(claim)
        }
      }
    }
    return result
  }

  /**
   * Path as it should READ in a room message: relative to the state root when
   * that is non-empty, else the absolute path. A claim on the root itself
   * yields `''` from `relative`, which used to render an empty bullet and hide
   * the very file the conflict is about.
   */
  private displayPath(path: string): string {
    const rel = relative(this.root, path)
    return rel === '' ? path : rel
  }

  /** Notify the room of a conflict (fire-and-forget from `declare`). */
  async notifyRoom(
    roomId: string,
    conflicts: ConflictClaim[],
    callerSessionId: string,
  ): Promise<void> {
    // Post a system message to the room warning about the conflict.
    const paths = [...new Set(conflicts.map(c => c.path))]
    const sessions = [...new Set(conflicts.map(c => c.sessionId))]
    const text = `[conflict detected] Multiple sessions claim the same file path(es):\n`
      + paths.map(p => `- ${neutralize(this.displayPath(p))}`).join('\n')
      + `\nSessions involved: ${sessions.map(s => neutralize(s.slice(0, 12))).join(', ')}`
    try {
      await this.deps.store.postMessage(roomId, {
        text: clampText(text, this.deps.cfg().caps.logLineChars * 4),
        fromKind: 'system',
        fromLabel: 'conflict-detector',
      })
    } catch (error) {
      this.warn(`room notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Start periodic expiry cleanup. Call once at boot. */
  startExpiryCleanup(intervalMs = 60_000): void {
    if (this.expiryTimer !== null) return
    this.expiryTimer = setInterval(() => {
      const expired = this.expireClaims()
      if (expired.length > 0) {
        this.warn(`${String(expired.length)} claim(s) expired`)
      }
    }, intervalMs)
    // Weak ref so it doesn't prevent GC.
    if (typeof this.expiryTimer.unref === 'function') {
      this.expiryTimer.unref()
    }
  }

  /** Stop cleanup timer. */
  stopExpiryCleanup(): void {
    if (this.expiryTimer !== null) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  /** Clear all state (tests / reset). */
  clear(): void {
    this.stopExpiryCleanup()
    this.claims.clear()
    this.byId.clear()
  }

  /** Size for debugging. */
  size(): number {
    let count = 0
    for (const roomClaims of this.claims.values()) {
      for (const pathClaims of roomClaims.values()) {
        count += pathClaims.size
      }
    }
    return count
  }
}

// ----------------------------------------------------------------- cache --

const instances = new Map<string, ConflictService>()

export function conflictService(deps: ModuleDeps): ConflictService {
  const existing = instances.get(deps.store.root)
  if (existing !== undefined) return existing
  const created = new ConflictService(deps)
  instances.set(deps.store.root, created)
  return created
}

export function resetConflictService(root: string): void {
  instances.delete(root)
}

// ------------------------------------------------------------------- tools --

export function conflictTools(svc: ConflictService): ToolDefinition[] {
  const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

  function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : ''
  }
  function num(v: unknown, min = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : min
  }

  const declare = defineTool({
    name: 'cortex_conflict_declare',
    description:
      'Declare an intent to write a file path. Call this BEFORE starting to edit a shared file '
      + 'so other agents in the same room can detect the conflict. Returns the claim id (keep it '
      + 'to release later) and any existing conflicts. Pass ttlSeconds to auto-expire the claim.',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Room id where the conflict should be detected.' },
        path: { type: 'string', description: 'Absolute file path being written.' },
        description: { type: 'string', description: 'Brief description of what is being written.' },
        sessionId: { type: 'string', description: 'Session id making the claim (defaults to caller).' },
        ttlSeconds: { type: 'number', description: 'Auto-expire after N seconds. 0 = never (default).' },
      },
      required: ['roomId', 'path'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: Args, execution: { signal: AbortSignal; agent?: HostAgent }) => {
      const roomId = str((args as Args).roomId)
      const path = str((args as Args).path)
      const description = str((args as Args).description)
      const _ttl: unknown = (args as Args).ttlSeconds
      const ttlSeconds: number = typeof _ttl === 'number' ? _ttl : 0
      const givenSession = str((args as Args).sessionId)
      const callerSession = givenSession !== '' ? givenSession : (callerSessionId(execution.agent) ?? '')

      if (roomId === '') return neutralizeDeep({ status: 'refused', message: 'roomId is required.' })
      if (path === '') return neutralizeDeep({ status: 'refused', message: 'path is required.' })

      const result = svc.declare({ roomId, path, description, sessionId: callerSession, ttlSeconds: ttlSeconds ?? 0 })
      if (!result.ok) return neutralizeDeep({ status: 'refused', message: result.message })

      const out: Record<string, unknown> = {
        status: 'declared',
        message: result.message,
        claimId: result.claim?.id ?? null,
        path: result.claim?.path ?? path,
        conflicts: result.conflicts?.map(c => ({
          sessionId: c.sessionId,
          description: c.description,
          declaredAt: c.declaredAt,
          claimId: c.id,
        })) ?? [],
      }
      return neutralizeDeep(out)
    },
  } as never)

  const check = defineTool({
    name: 'cortex_conflict_check',
    description:
      'Check for conflicts on a path, or list all conflicts in a room. '
      + 'Call this BEFORE writing a file to see if another agent has already claimed it. '
      + 'If path is omitted, returns all active conflicts in the room.',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Room id to check.' },
        path: { type: 'string', description: 'Specific path to check (optional). If omitted, lists all conflicts.' },
        sessionId: { type: 'string', description: 'Session to exclude from conflict detection (defaults to caller).' },
      },
      required: ['roomId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: Args, execution: { signal: AbortSignal; agent?: HostAgent }) => {
      const roomId = str((args as Args).roomId)
      const path = str((args as Args).path)
      const givenSession = str((args as Args).sessionId)
      const callerSession = givenSession !== '' ? givenSession : (callerSessionId(execution.agent) ?? '')

      if (roomId === '') return neutralizeDeep({ status: 'refused', message: 'roomId is required.' })

      const result = svc.check({ roomId, path: path || undefined, sessionId: callerSession })
      if (!result.ok) return neutralizeDeep({ status: 'refused', message: result.message })

      const out: Record<string, unknown> = {
        status: result.result?.hasConflict === true ? 'conflict' : 'clear',
        message: result.message,
        hasConflict: result.result?.hasConflict ?? false,
        conflicts: result.result?.conflicts ?? [],
        ownClaimId: result.result?.ownClaimId ?? null,
      }
      if (result.allConflicts !== undefined) {
        out.allConflicts = result.allConflicts.map(c => ({
          sessionId: c.sessionId,
          path: c.path,
          description: c.description,
          claimId: c.id,
        }))
      }
      return neutralizeDeep(out)
    },
  } as never)

  const release = defineTool({
    name: 'cortex_conflict_release',
    description:
      'Release a previously declared conflict claim. Call this when done writing '
      + 'so other agents know the path is free. Pass the claim id returned by declare.',
    parameters: {
      type: 'object',
      properties: {
        claimId: { type: 'string', description: 'The claim id returned by cortex_conflict_declare.' },
      },
      required: ['claimId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: Args) => {
      const claimId = str((args as Args).claimId)
      if (claimId === '') return neutralizeDeep({ status: 'refused', message: 'claimId is required.' })
      const result = svc.release(claimId)
      return neutralizeDeep({ status: result.ok ? 'released' : 'refused', message: result.message })
    },
  } as never)

  const list = defineTool({
    name: 'cortex_conflict_list',
    description:
      'List all active conflict claims, optionally filtered by room. '
      + 'Useful for debugging and for the orchestrator to see the current state.',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Optional room id to filter.' },
      },
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: Args) => {
      const roomId = str((args as Args).roomId) || undefined
      const claims = svc.listClaims(roomId)
      return neutralizeDeep({
        status: 'ok',
        count: claims.length,
        claims: claims.map(c => ({
          claimId: c.id,
          roomId: c.roomId,
          sessionId: c.sessionId,
          path: c.path,
          description: c.description,
          declaredAt: c.declaredAt,
          ttlSeconds: c.ttlSeconds,
        })),
      })
    },
  } as never)

  return [declare, check, release, list]
}
