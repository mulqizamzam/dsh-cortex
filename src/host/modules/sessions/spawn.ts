/**
 * Session spawn + targeted send (DESIGN §4, docs/HOST-API.md §6, BRIEFS §M5).
 *
 * Spawn goes through ONE host door: `ctx.agents.create`. It is conditional by
 * design — the registry only has a factory once an agent-loop plugin is loaded
 * (`packages/core/agent/src/index.ts:405` + the NO_FACTORY error) — so it is
 * feature-detected and, when absent, answered with a refusal that names the
 * working alternative (`cortex_room_join` an existing live session). Nothing
 * here pretends a spawn happened.
 *
 * Accepted create options, read from host source rather than guessed
 * (`CreateAgentOptions`, packages/core/agent/src/index.ts:80-135):
 *   { sessionId, meta:{cwd?, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset?},
 *     seed?, agentOptions?:{provider?,model?,maxTokens?}, signal?, setup? }
 * This module supplies ONLY `sessionId`, `meta.cwd`, `meta.parentSession` and
 * `agentOptions.{provider,model}`; everything else is left to the host. The
 * return is an owned `AgentHandle {agent, dispose}` — we keep the handle in
 * {@link spawnedHandles} and NEVER dispose it, because a room member that is
 * torn down behind the user's back is worse than a handle we hold.
 *
 * `meta.cwd` guard (P5): the host validates that cwd is absolute and keys
 * session storage off it, so a model-supplied path is a real risk. v1 accepts a
 * cwd ONLY when it is (a) the caller's own cwd, (b) inside the caller's cwd, or
 * (c) inside the plugin state root. A configured prefix list
 * ({link SPAWN_CWD_ALLOWLIST}) is the seam for a future `rooms.spawnCwdPrefixes`
 * config key — this module does not own `src/host/types.ts`, so the list is
 * empty today and the rule is reported in every refusal.
 */
import { isAbsolute, resolve } from 'node:path'
import { clampText } from '../../../lib/caps.ts'
import { errorMessage } from '../../../lib/errors.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import { newId } from '../../../lib/ids.ts'
import type { HostAgent, HostAgentsService } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import type { RoomService } from '../rooms/service.ts'
import type { DeliveryCounts, DeliveryResult } from '../rooms/service.ts'
import { collectHandoff, renderHandoff, HANDOFF_BUDGET_CHARS } from './handoff.ts'
import { sharedScopeCache } from '../../scope.ts'

/** Extra absolute prefixes a spawn cwd may live under (empty in v1). */
export const SPAWN_CWD_ALLOWLIST: readonly string[] = []

/** How many sessions this process spawned; a cheap runaway guard (P2/P3). */
export const SPAWN_LIMIT = 8

/** Handle registry: sessionId -> the host handle we created it with. */
export interface SpawnedHandle {
  sessionId: string
  roomId: string
  createdAt: string
  /** Never called by this module; kept so the owner can tear down deliberately. */
  dispose?: () => Promise<unknown>
}

const spawnedHandles = new Map<string, SpawnedHandle>()

/** Session ids this process created (a dropped handle stays until recalled). */
export function spawnedSessionIds(): string[] {
  return [...spawnedHandles.keys()]
}

/**
 * How many spawned sessions are still live here. The runaway cap counts THESE,
 * not the history: a room whose workers finished must be able to spawn again.
 */
export function liveSpawnedCount(isLive: (sessionId: string) => boolean): number {
  return [...spawnedHandles.keys()].filter(sessionId => isLive(sessionId)).length
}

/** Forget a spawn (teardown path / tests): the cap is about live sessions. */
export function recallSpawnedSession(sessionId: string): boolean {
  return spawnedHandles.delete(sessionId)
}

/** The host factory, or undefined when this host cannot spawn (feature-detect). */
export function spawnFactory(agents: HostAgentsService | undefined): ((options: unknown) => Promise<unknown>) | undefined {
  if (agents === undefined || agents === null) return undefined
  const create = (agents as { create?: unknown }).create
  return typeof create === 'function'
    ? (options: unknown): Promise<unknown> => (create as (input: unknown) => Promise<unknown>).call(agents, options)
    : undefined
}

/** A fresh session id: crypto hex, prefixed so it cannot look host-minted. */
export function newSessionId(): string {
  // Brief asked for 8 hex; `lib/ids.newId()` is the package's only crypto id
  // primitive (12 hex, DESIGN §2 shape), so the extra entropy is kept and the
  // prefix marks provenance. Deviation reported to the parent.
  return `cortex-${newId()}`
}

export interface CwdDecision {
  ok: boolean
  /** The absolute cwd to use (may be undefined = inherit nothing). */
  cwd?: string
  reason: string
}

/**
 * The cwd guard. `callerCwd` is what the calling agent's session header reports;
 * `root` is the plugin state root.
 */
export function checkSpawnCwd(input: { requested?: unknown; callerCwd?: string; root: string }): CwdDecision {
  const requested = typeof input.requested === 'string' ? input.requested.trim() : ''
  if (requested === '') {
    if (input.callerCwd === undefined || input.callerCwd === '') {
      return { ok: true, reason: 'no cwd available on either side; the host decides the new session cwd' }
    }
    return { ok: true, cwd: input.callerCwd, reason: `inherited the caller cwd (${clampText(input.callerCwd, 120)})` }
  }
  if (!isAbsolute(requested)) {
    return { ok: false, reason: `cwd must be an absolute path; got "${clampText(requested, 120)}"` }
  }
  const target = resolve(requested)
  const insideCaller = input.callerCwd !== undefined && input.callerCwd !== '' && isSameOrInside(target, resolve(input.callerCwd))
  const insideRoot = isSameOrInside(target, resolve(input.root))
  const insideAllowlist = SPAWN_CWD_ALLOWLIST.some(prefix => isSameOrInside(target, resolve(prefix)))
  if (insideCaller || insideRoot || insideAllowlist) {
    return { ok: true, cwd: target, reason: `accepted cwd ${clampText(target, 140)}` }
  }
  return {
    ok: false,
    reason: `refused cwd ${clampText(target, 140)}: v1 spawns only into the caller's own cwd (${clampText(input.callerCwd ?? 'unknown', 120)}) or the plugin state root (${clampText(input.root, 120)}). Omit cwd to inherit, or ask the operator for rooms.spawnCwdPrefixes.`,
  }
}

/** `dir === target` or target strictly under dir. */
function isSameOrInside(target: string, dir: string): boolean {
  if (target === dir) return true
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  return target.startsWith(prefix)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export interface SpawnInput {
  roomId: string
  label: string
  prompt: string
  cwd?: unknown
  provider?: unknown
  model?: unknown
  fromSessionId?: string
}

export interface SpawnOutcome {
  ok: boolean
  message: string
  sessionId?: string
  roomId: string
  counts?: DeliveryCounts
  results?: DeliveryResult[]
  hint?: string
}

export interface SpawnDeps {
  deps: ModuleDeps
  rooms: RoomService
}

/**
 * Create a session, enroll it in `roomId`, then hand it the prompt. The prompt
 * task IS stored as a room message (auditable, replayable, same ledger as every
 * other mail) but only the new member is reached immediately, so a room of six
 * idle sessions is not woken by a private instruction. A labelled system line
 * announces the join to everybody.
 */
export async function spawnSession(input: SpawnInput, { deps, rooms }: SpawnDeps): Promise<SpawnOutcome> {
  const cfg = deps.cfg()
  if (!cfg.rooms.enabled) {
    return { ok: false, roomId: input.roomId, message: 'rooms are disabled by config (rooms.enabled = false), so no session was spawned.' }
  }
  const roomId = typeof input.roomId === 'string' ? input.roomId.trim() : ''
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (roomId === '' || label === '' || prompt === '') {
    return { ok: false, roomId, message: 'spawn needs all three of: roomId, label and prompt.' }
  }
  const room = await rooms.get(roomId)
  if (room === undefined) {
    return { ok: false, roomId, message: `no such room: ${neutralize(roomId)}. cortex_room_list shows what exists.` }
  }
  if (input.fromSessionId !== undefined && !room.members.some(member => member.sessionId === input.fromSessionId)) {
    return {
      ok: false,
      roomId,
      hint: `cortex_room_join {roomId: "${roomId}"} joins the caller first`,
      message: `the calling session (${input.fromSessionId}) is not a member of ${roomId}, so it cannot populate a room with a session it created. Join first, then spawn.`,
    }
  }
  const create = spawnFactory(deps.ctx.agents)
  const refusalHint = 'Rooms still work without spawn: enroll sessions that already exist with cortex_room_join {roomId, sessionId}, and they will read + answer room mail.'
  if (create === undefined) {
    return {
      ok: false,
      roomId,
      hint: refusalHint,
      message: 'this host exposes no agent factory (ctx.agents.create is absent — an agent-loop plugin owns it), so no session was created. ' + refusalHint,
    }
  }
  const liveSpawned = liveSpawnedCount(sessionId => rooms.live(sessionId) !== undefined)
  if (liveSpawned >= SPAWN_LIMIT) {
    return {
      ok: false,
      roomId,
      hint: refusalHint,
      message: `this process already has ${String(liveSpawned)} spawned session(s) live (cap ${String(SPAWN_LIMIT)}); refusing to add another. ${refusalHint}`,
    }
  }
  const caller = input.fromSessionId === undefined ? undefined : deps.ctx.agents?.get?.(input.fromSessionId)
  const cwd = checkSpawnCwd({
    ...(input.cwd === undefined ? {} : { requested: input.cwd }),
    callerCwd: caller?.session?.header?.cwd,
    root: deps.store.root,
  })
  if (!cwd.ok) {
    return { ok: false, roomId, hint: 'omit cwd to inherit the caller cwd', message: `refused: ${cwd.reason}` }
  }
  const provider = typeof input.provider === 'string' && input.provider.trim() !== '' ? input.provider.trim() : caller?.options?.provider
  const model = typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : caller?.options?.model
  const agentOptions: { provider?: string; model?: string } = {}
  if (provider !== undefined && provider !== '') agentOptions.provider = provider
  if (model !== undefined && model !== '') agentOptions.model = model

  const sessionId = newSessionId()
  let handle: unknown
  try {
    handle = await create({
      sessionId,
      meta: {
        ...(cwd.cwd === undefined ? {} : { cwd: cwd.cwd }),
        ...(input.fromSessionId === undefined ? {} : { parentSession: input.fromSessionId }),
      },
      ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
    })
  } catch (error) {
    return {
      ok: false,
      roomId,
      hint: refusalHint,
      message: `the host refused to create the session: ${neutralize(clampText(errorMessage(error), 300))}. ${refusalHint}`,
    }
  }

  // The host returns an owned AgentHandle; its agent may carry a different id
  // than we asked for, so trust the handle.
  const agent = (handle as { agent?: HostAgent } | undefined)?.agent
  const realId = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : sessionId
  const dispose = (handle as { dispose?: unknown } | undefined)?.dispose
  spawnedHandles.set(realId, {
    sessionId: realId,
    roomId,
    createdAt: new Date().toISOString(),
    ...(typeof dispose === 'function' ? { dispose: (): Promise<unknown> => (dispose as () => Promise<unknown>).call(handle) } : {}),
  })

  const joined = await rooms.join(roomId, {
    label,
    sessionId: realId,
    ...(model === undefined ? {} : { model }),
    ...(cwd.cwd === undefined ? {} : { cwd: cwd.cwd }),
  })
  const announced = await rooms.post({
    roomId,
    text: `session "${clampText(label, 40)}" (${realId}) was spawned by ${input.fromSessionId ?? 'a session without an id'}; cwd ${cwd.cwd ?? 'host default'}. The task was given to it directly, not posted here.`,
    fromKind: 'system',
    fromLabel: 'dsh-cortex',
    notifyOnly: [],
  })
  // Deliver the task itself as room mail to the new session only: same banner,
  // same ledger, so a session that never wakes still reads it next turn.
  let fullPrompt = prompt
  if (cfg.handoff?.enabled === true) {
    // Generate the handoff block from what the store already holds. A failed
    // read contributes an honest error line; it never invents content. The
    // handoff is prepended to the prompt so the spawned agent starts with context.
    const callerCwd = cwd.cwd
    // The handoff must tell the spawned agent which project it is working on.
    // A cwd basename (`parts[parts.length - 1]`) is wrong for two reasons: two
    // repos with the same name share the same label, and the spawn happens
    // from a cwd that might not be the repo root (worktree, sub-directory).
    // `lib/pid.ts` derives the canonical project id from the git remote
    // (winning over cwd) and the store keys every project directory by that
    // same value — so the spawned agent gets the key the tool surface uses,
    // not a display name it would have to guess at.
    // M4: use the shared scope cache (alive since M3), not a fresh probe.
    let projectName: string | undefined
    if (callerCwd !== undefined) {
      const scope = await sharedScopeCache().resolve(callerCwd)
      projectName = scope.pid
    }
    const source = {
      today: (): string => new Date().toISOString().slice(0, 10),
      label: (): string => cfg.injectLabel,
      openTodos: async (): Promise<import('../../types.ts').TodoItem[]> => {
        const result = await deps.store.listTodos({ openOnly: true })
        return result.ok ? result.data : []
      },
      readLog: async (scope: import('../../types.ts').LogRef['scope'], pid?: string) => {
        const result = await deps.store.logRead({ scope, lastDays: 2, ...(pid === undefined ? {} : { pid }) })
        if (!result.ok) return { text: '', error: result.error }
        return { text: result.data.text }
      },
      projectName: (): string | undefined => projectName,
    }
    try {
      const handoffInput = await collectHandoff(source)
      const handoffResult = renderHandoff(handoffInput)
      if (!handoffResult.suppressed && handoffResult.text !== '') {
        fullPrompt = `${handoffResult.text}\n\n${prompt}`
      }
    } catch {
      // A failed handoff read must not block the spawn; the prompt goes out bare.
      deps.warn('sessions: handoff generation failed; prompt sent without context block')
    }
  }
  const tasked = await rooms.post({
    roomId,
    text: fullPrompt,
    fromKind: 'session',
    ...(input.fromSessionId === undefined ? {} : { fromSessionId: input.fromSessionId }),
    fromLabel: input.fromSessionId === undefined ? 'dsh-cortex' : `session ${clampText(input.fromSessionId, 24)}`,
    notify: true,
    notifyOnly: [realId],
  })

  const outcome: SpawnOutcome = {
    ok: true,
    roomId,
    sessionId: realId,
    message: [
      `spawned session ${realId} (${neutralize(clampText(label, 40))}) in ${roomId}`,
      cwd.reason === '' ? '' : `cwd: ${cwd.reason}`,
      joined.ok ? '' : `WARNING: it was created but could not join the room: ${joined.message}`,
      announced.ok ? '' : `WARNING: the join announcement did not post: ${announced.message}`,
      `task delivery: ${tasked.message}`,
    ].filter(line => line !== '').join('\n'),
    ...(tasked.counts === undefined ? {} : { counts: tasked.counts }),
    ...(tasked.results === undefined ? {} : { results: tasked.results }),
  }
  deps.log(`sessions: spawned ${realId} into ${roomId}`)
  return outcome
}

/**
 * Targeted send: post to one session and report what the host accepted.
 * The room record is what makes this auditable — a direct send with no room is
 * refused rather than becoming an off-the-books channel between sessions.
 */
export interface SendInput {
  sessionId: string
  text: string
  roomId?: string
  fromSessionId?: string
  fromLabel?: string
  images?: readonly unknown[]
}

export interface SendOutcome {
  ok: boolean
  message: string
  counts?: DeliveryCounts
  results?: DeliveryResult[]
  seq?: number
}

export async function sendToSession(input: SendInput, { deps, rooms }: SpawnDeps): Promise<SendOutcome> {
  if (!deps.cfg().rooms.enabled) {
    return { ok: false, message: 'rooms are disabled by config (rooms.enabled = false); nothing was sent.' }
  }
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  const text = typeof input.text === 'string' ? input.text : ''
  if (sessionId === '' || text.trim() === '') return { ok: false, message: 'send needs a sessionId and a non-empty text.' }
  const targetRooms = await rooms.roomsFor(sessionId)
  const wanted = stringOf(input.roomId)
  // The room has to bind BOTH sides: membership is what authorizes a send, and
  // a message written into a room only the target joined would have no author.
  const shared = targetRooms.filter(room =>
    (wanted === '' || room.id === wanted)
    && (input.fromSessionId === undefined || room.members.some(member => member.sessionId === input.fromSessionId)))
  if (shared.length === 0) {
    const roomHint = wanted === ''
      ? (targetRooms.length === 0
        ? `session ${sessionId} is not a member of any room`
        : `you and session ${sessionId} share no room (it is in: ${targetRooms.map(room => room.id).join(', ')})`)
      : `session ${sessionId} is not a member of ${neutralize(wanted)}`
    return {
      ok: false,
      message: `${roomHint}. Room membership is what authorizes a send (DESIGN §4): cortex_room_join {roomId, sessionId} first, or enroll a live session by id.`,
    }
  }
  // Newest room first: the room the caller most recently used is the one they mean.
  const room = shared[0]
  if (room === undefined) {
    return { ok: false, message: 'the membership check found no usable room for this target.' }
  }
  const result = await rooms.post({
    roomId: room.id,
    text,
    ...(input.images === undefined ? {} : { images: input.images }),
    fromKind: 'session',
    ...(input.fromSessionId === undefined ? {} : { fromSessionId: input.fromSessionId }),
    fromLabel: input.fromLabel ?? (input.fromSessionId === undefined ? undefined : `session ${clampText(input.fromSessionId, 24)}`),
    notify: true,
    notifyOnly: [sessionId],
  })
  if (!result.ok) return { ok: false, message: `send failed: ${result.message}` }
  const disposition = (result.results ?? []).find(item => item.sessionId === sessionId)
  const live = rooms.live(sessionId)
  const note = live === undefined
    ? 'the target has no live agent here, so the message stays unread and is injected at its next turn'
    : `the target is ${live.status}; ${disposition === undefined ? 'no delivery was attempted' : `disposition ${disposition.disposition} (${disposition.detail})`}`
  return {
    ok: true,
    seq: result.seq,
    message: `sent to ${sessionId} via room ${room.id}: ${result.message}\n${note}`,
    ...(result.counts === undefined ? {} : { counts: result.counts }),
    ...(result.results === undefined ? {} : { results: result.results }),
  }
}
