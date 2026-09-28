/**
 * Room + mail mechanics for the `rooms` module (DESIGN §2 rooms, §4 room tools,
 * §9.1 G-02 + the wake-disposition ruling).
 *
 * One service owns everything so the agent tools and the RPC endpoints cannot
 * drift apart:
 *
 *  - room CRUD, membership, and status with LIVE agent state joined in;
 *  - posting, with images copied ONLY from inside the state root (`images.ts`);
 *  - delivery, exactly one ledger per (session, room):
 *      idle    -> `agent.followup()`  = wake now
 *      running -> `agent.steer()`     = nearest step boundary (pre-step)
 *      absent  -> skip: nothing to call; the message stays unread and the
 *                 `cortex:rooms` prompt context renders it when that session
 *                 next assembles a turn.
 *    A mail is popped from the queue BEFORE the host call and re-queued if that
 *    call throws, so a message is never both steered and re-rendered by the
 *    context seam, and never silently lost. Counts come back per class.
 *  - the unread ledger: an in-memory queue plus a consumed-watermark file at
 *    `rooms/<roomId>/consumed/<sessionId>.json`. The store's inject queue cannot
 *    carry it — `InjectQueueItem` is `{promptId, mode, at}` (prompt-only), so it
 *    has no seq field and would collide with the prompt library. Deviation
 *    reported to the parent.
 *
 * `node:fs` stays out of this file (M0 rule): reads/writes go through
 * `src/lib/*`; `node:path` only joins paths. Every model-visible string leaves
 * through `neutralize()` (P9).
 */
import { join } from 'node:path'
import { clampText } from '../../../lib/caps.ts'
import type { CortexCaps } from '../../../lib/caps.ts'
import { errorMessage } from '../../../lib/errors.ts'
import { listDir, readJsonSafe } from '../../../lib/fsx.ts'
import { ensureDir } from '../../../lib/home.ts'
import { isSafeKey, newId } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { HostAgent, HostUserMessage } from '../../dsh.ts'
import type { ModuleDeps, Room, RoomMember, RoomMemberState, RoomMessage } from '../../types.ts'
import { ConfirmTokens } from '../memory/ops.ts'
import { ensureRoomInbox, importRoomImage, roomInboxDir } from './images.ts'
import { MAIL_LABEL, MAIL_MAX_PER_TURN, mailFromMessage, renderMail, renderMailBlock } from './mail.ts'
import type { RoomMail } from './mail.ts'

/** How many unread mails one session may hold in memory (P2 ceiling). */
export const QUEUE_MAX = 25

/** Ceiling on room directories scanned by `list()` (P2). */
export const ROOM_LIST_MAX = 200

/** A session id turned into a safe file stem — same rule the store applies. */
export function safeSessionKey(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown'
}

const ledgerKey = (sessionId: string, roomId: string): string => `${sessionId}\u0000${roomId}`

/** Identity of one mail inside one room (queue + ledger dedupe key). */
const seqKey = (roomId: string, seq: number): string => `${roomId}\u0000${String(seq)}`

/** Where a session's consumed watermark for one room lives. */
export function consumedFile(store: ModuleDeps['store'], roomId: string, sessionId: string): string {
  return join(store.paths.room(roomId), 'consumed', `${safeSessionKey(sessionId)}.json`)
}

/** Consumed-watermark file shape (owned by this module, not a store type). */
export interface ConsumedRow {
  sessionId: string
  roomId: string
  lastSeq: number
  updatedAt: string
}

/** What one delivery attempt decided (DESIGN §9.1 wake disposition). */
export type Disposition = 'wake' | 'steer' | 'skip-offline' | 'skip-deferred' | 'skip-self' | 'failed'

export interface DeliveryResult {
  sessionId: string
  label: string
  disposition: Disposition
  detail: string
}

export interface DeliveryCounts {
  wake: number
  steer: number
  offline: number
  failed: number
  self: number
  /** Members left unread on purpose (`notifyOnly` targeted sends). */
  deferred: number
}

export function emptyCounts(): DeliveryCounts {
  return { wake: 0, steer: 0, offline: 0, failed: 0, self: 0, deferred: 0 }
}

/** Counts as honest text — every tool result carries these numbers. */
export function formatCounts(counts: DeliveryCounts, results: readonly DeliveryResult[] = []): string {
  const parts = [
    `wake ${String(counts.wake)}`,
    `next-step ${String(counts.steer)}`,
    `offline ${String(counts.offline)}`,
    `failed ${String(counts.failed)}`,
  ]
  if (counts.deferred > 0) parts.push(`deferred ${String(counts.deferred)}`)
  const head = `delivered: ${parts.join(', ')}`
  if (results.length === 0) return head
  return `${head}\n${results.map(item => `  ${item.sessionId} -> ${item.disposition}${item.detail === '' ? '' : ` (${item.detail})`}`).join('\n')}`
}

/**
 * A mail as the host expects it: `source.kind = 'plugin'` (never `'user'`,
 * G-02) plus the first-line banner in the text itself, so authorship survives
 * whatever a given host build renders for plugin sources.
 */
export function roomMailMessage(mails: readonly RoomMail[], root: string, label: string = MAIL_LABEL): HostUserMessage {
  const body = mails.map(mail => renderMail(mail, root)).join('\n\n')
  return {
    id: `cortex-room-${newId()}`,
    // The host has no non-user role for inbox traffic; authorship is the
    // `source` field, and the banner repeats it in the text (belt + braces).
    role: 'user',
    content: [{ type: 'text', text: neutralize(`${neutralize(label)}\n${body}`) }],
    source: { kind: 'plugin', plugin: 'dsh-cortex' },
  }
}

/** Who a tool call is speaking for: the calling agent's session id. */
export function callerSessionId(agent: HostAgent | undefined): string | undefined {
  return typeof agent?.id === 'string' && agent.id !== '' ? agent.id : undefined
}

export interface PostInput {
  roomId: string
  text: string
  /** Absolute paths inside the state root; anything else is refused. */
  images?: readonly unknown[]
  fromSessionId?: string
  fromLabel?: string
  fromKind?: RoomMessage['fromKind']
  jobId?: string
  /** Default true: live members are woken/steered as soon as it is posted. */
  notify?: boolean
  /** Restrict the immediate wake-up to these session ids (all members still store it). */
  notifyOnly?: readonly string[]
}

export interface PostOutcome {
  ok: boolean
  message: string
  seq?: number
  images?: string[]
  refused?: string[]
  counts?: DeliveryCounts
  results?: DeliveryResult[]
}

export interface MemberInput {
  label: string
  sessionId?: string
  model?: string
  cwd?: string
}

/**
 * Rooms over the file store. Get one through {@link roomsService}: the instance
 * is cached per state root so the rooms tools, the sessions tools and the
 * `cortex:rooms` context seam share ONE in-memory queue.
 */
export interface DeleteRoomInput {
  roomId: string
  /** The single-use token from the first call; absent means "issue one". */
  confirm?: unknown
}

export interface DeleteRoomOutcome {
  ok: boolean
  message: string
  /** Present only on the first call, which deletes nothing. */
  token?: string
  deleted?: boolean
}

export class RoomService {
  private readonly deps: ModuleDeps
  /** `sessionId|roomId` -> highest seq already handed to that session. */
  private readonly consumed = new Map<string, number>()
  /** sessionId -> unread mails, oldest first. */
  private readonly queue = new Map<string, RoomMail[]>()
  /** Sessions whose ledger has been read from disk in this process. */
  private readonly primed = new Set<string>()
  /** In-flight watermark writes; {@link flushLedger} awaits them. */
  private readonly pendingWrites = new Set<Promise<void>>()
  /** Single-use tokens for the two-step delete, keyed to a room id. */
  private readonly tokens = new ConfirmTokens()

  constructor(deps: ModuleDeps) {
    this.deps = deps
  }

  get root(): string {
    return this.deps.store.root
  }

  private warn(message: string): void {
    this.deps.warn(`rooms: ${message}`)
  }

  /** False when `rooms.enabled` is off (P3 kill-switch). */
  get enabled(): boolean {
    return this.deps.cfg().rooms.enabled === true
  }

  /** Live caps, for render-side budgets (never destructured at mount). */
  caps(): CortexCaps {
    return this.deps.cfg().caps
  }

  /**
   * Stamp the author's member row with the moment it spoke, so `rooms.list`
   * `lastSeen` and `cortex_room_status` `lastActivityAt` mean something.
   * Best-effort: a failed stamp never fails the post (P4).
   */
  private async touchMember(room: Room, sessionId: string | undefined): Promise<void> {
    if (sessionId === undefined) return
    const at = new Date().toISOString()
    try {
      // Re-read: the post advanced `lastSeq` on disk after our snapshot, and a
      // whole-file rewrite of a stale room would roll that back.
      const fresh = await this.get(room.id)
      if (fresh === undefined) return
      let changed = false
      const members = fresh.members.map(member => {
        if (member.sessionId !== sessionId) return member
        changed = true
        return { ...member, lastActivityAt: at, state: this.stateOf(member) }
      })
      if (!changed) return
      const stamped = await this.deps.store.writeStateJson(this.deps.store.paths.roomDoc(fresh.id), { ...fresh, members })
      if (!stamped.ok) throw new Error(stamped.error)
    } catch (error) {
      this.warn(`member stamp failed for ${room.id}/${sessionId}: ${errorMessage(error)}`)
    }
  }

  // ----------------------------------------------------------- live agents --
  /** Live agent handle, or undefined when that session is not running here. */
  live(sessionId: string | undefined): HostAgent | undefined {
    if (sessionId === undefined || sessionId === '') return undefined
    const agents = this.deps.ctx.agents
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    try {
      return agents.get(sessionId) ?? undefined
    } catch (error) {
      this.warn(`agents.get(${sessionId}) failed: ${errorMessage(error)}`)
      return undefined
    }
  }

  /** Every live root session ([] when the host exposes no agents service). */
  liveAgents(): HostAgent[] {
    const agents = this.deps.ctx.agents
    if (agents === undefined || typeof agents.roots !== 'function') return []
    try {
      return agents.roots()
    } catch (error) {
      this.warn(`agents.roots() failed: ${errorMessage(error)}`)
      return []
    }
  }

  /** Stored row joined with live state; 'gone' when there is no live agent. */
  stateOf(member: Pick<RoomMember, 'sessionId'>): RoomMemberState {
    const sessionId = member.sessionId
    if (sessionId === undefined || sessionId === '') return 'unknown'
    const agent = this.live(sessionId)
    if (agent === undefined) return 'gone'
    return agent.status === 'running' ? 'running' : 'idle'
  }

  // ------------------------------------------------------------ room CRUD --
  async create(input: { title: string; createdBy?: string; joinAs?: MemberInput }): Promise<{ ok: boolean; room?: Room; message: string }> {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') return { ok: false, message: 'a room needs a non-empty title' }
    const created = await this.deps.store.createRoom({
      title,
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    })
    if (!created.ok || created.data === null || created.data === undefined) {
      return { ok: false, message: `could not create room: ${created.error ?? 'unknown'}` }
    }
    const room = created.data
    try {
      await ensureRoomInbox(this.deps.store, room.id)
    } catch (error) {
      this.warn(`inbox scaffold failed for ${room.id}: ${errorMessage(error)}`)
    }
    if (input.joinAs !== undefined) await this.join(room.id, input.joinAs)
    return {
      ok: true,
      room,
      message: `room ${room.id} created - "${neutralize(room.title)}". Files to post go in ${roomInboxDir(this.deps.store, room.id)}.`,
    }
  }

  /**
   * Rooms from disk. `CortexStore.listRooms` is named in `.dev/M0-NOTES.md`
   * §1.4 but is NOT defined in `src/host/store.ts`, so this module reads the
   * documented layout through the exported primitives.
   * TODO(PARENT): replace the body with `store.listRooms()` once it lands.
   */
  async list(): Promise<Room[]> {
    const store = this.deps.store
    const { names, truncated } = await listDir(join(store.root, 'rooms'), ROOM_LIST_MAX)
    if (truncated) this.warn(`room listing hit the ${String(ROOM_LIST_MAX)}-room ceiling; later rooms are not shown`)
    const rooms: Room[] = []
    for (const name of names) {
      if (!isSafeKey(name)) continue
      const room = await store.getRoom(name)
      if (room.ok && room.data !== null && room.data !== undefined) rooms.push(room.data)
    }
    return rooms.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  async get(roomId: string): Promise<Room | undefined> {
    if (typeof roomId !== 'string' || !isSafeKey(roomId)) return undefined
    const result = await this.deps.store.getRoom(roomId)
    return result.ok ? result.data ?? undefined : undefined
  }

  /** Join (or refresh) a member row. `joinRoom` keys members on sessionId. */
  async join(roomId: string, member: MemberInput): Promise<{ ok: boolean; room?: Room; message: string }> {
    const label = typeof member.label === 'string' ? member.label.trim() : ''
    if (label === '') return { ok: false, message: 'a room member needs a label' }
    const row: Partial<RoomMember> & { label: string } = {
      label,
      state: this.stateOf({ sessionId: member.sessionId }),
      ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
      ...(member.model === undefined ? {} : { model: member.model }),
      ...(member.cwd === undefined ? {} : { cwd: member.cwd }),
    }
    const joined = await this.deps.store.joinRoom(roomId, row)
    if (!joined.ok || joined.data === null || joined.data === undefined) {
      return { ok: false, message: `could not join room ${neutralize(roomId)}: ${joined.error ?? 'unknown'}` }
    }
    return { ok: true, room: joined.data, message: `joined ${roomId} as ${neutralize(clampText(label, 60))}` }
  }

  /**
   * Remove a member. `CortexStore.updateRoom` is likewise named in M0-NOTES and
   * absent from store.ts, so this module rewrites `room.json` itself (inside the
   * state root; TODO(PARENT): promote to the store and delete this body).
   */
  async leave(roomId: string, sessionId: string): Promise<{ ok: boolean; message: string }> {
    const room = await this.get(roomId)
    if (room === undefined) return { ok: false, message: `no such room: ${neutralize(roomId)}` }
    const members = room.members.filter(member => member.sessionId !== sessionId)
    if (members.length === room.members.length) return { ok: false, message: `session ${sessionId} is not a member of ${roomId}` }
    try {
      const written = await this.deps.store.writeStateJson(this.deps.store.paths.roomDoc(room.id), { ...room, members })
      if (!written.ok) throw new Error(written.error)
    } catch (error) {
      return { ok: false, message: `could not rewrite room ${roomId}: ${errorMessage(error)}` }
    }
    return { ok: true, message: `left room ${roomId}` }
  }

  /**
   * Delete a room, in two steps like the memory delete.
   *
   * The first call names the room and returns a single-use token bound to that
   * room id; only the second call, presenting the token, deletes. A mistyped id
   * therefore cannot destroy anything: the token is issued for the id that
   * actually resolved, and a token issued for one room does not open another.
   *
   * A RUNNING member does not block the delete, and that is deliberate. It was
   * tempting to refuse: deleting under a live agent feels like breaking
   * something behind its back. But the premise does not hold. `post` and `read`
   * both begin with a `get` and answer `no such room: <id>` when it is gone, so
   * the agent gets a clear, recoverable error on its next call rather than a
   * silent hang. Refusing would also have been unrecoverable: `leave` is only
   * reachable from the panel's RPC endpoint, an agent has no tool for it, so a
   * refused room could never be deleted at all. The running members are named in
   * the first call instead, so the cost is visible before anyone pays it.
   */
  async delete(input: DeleteRoomInput): Promise<DeleteRoomOutcome> {
    if (!this.enabled) return { ok: false, message: 'rooms are disabled by config (rooms.enabled = false); nothing was changed.' }
    const roomId = input.roomId.trim()
    if (roomId === '') return { ok: false, message: 'cortex_room_delete needs a roomId.' }
    const room = await this.get(roomId)
    if (room === undefined) return { ok: false, message: `no such room: ${neutralize(roomId)}` }

    const live = room.members.filter(member => this.stateOf(member) === 'running')
    if (input.confirm === undefined) {
      const count = room.members.length
      const listed = await this.deps.store.listBoards(roomId)
      const boards = listed.ok ? listed.data.length : 0
      const summary = [
        `${neutralize(room.title)} (${count} member(s), ${boards} board(s), ${room.lastSeq} message(s))`,
        live.length === 0
          ? 'no member is running'
          : `WARNING: ${live.length} member(s) are still running (${live.map(member => neutralize(String(member.label ?? '?'))).join(', ')}); they will get "no such room" on their next room call`,
      ].join('; ')
      return {
        ok: true,
        message: `room ${roomId}: ${summary}. Call again with confirm set to the token to delete it. This is not reversible.`,
        token: this.tokens.issue(roomId),
        deleted: false,
      }
    }

    if (typeof input.confirm !== 'string' || input.confirm.trim() === '') {
      return { ok: false, message: `cortex_room_delete needs the token from its first call as confirm.` }
    }
    if (!this.tokens.consume(input.confirm.trim(), roomId)) {
      return { ok: false, message: `that token is not valid for room ${roomId} (expired, already used, or issued for another room); nothing was deleted.` }
    }
    const removed = await this.deps.store.deleteRoom(roomId)
    if (!removed.ok) return { ok: false, message: `could not delete room ${roomId}: ${removed.error}` }
    if (!removed.data) return { ok: false, message: `room ${roomId} vanished before the delete landed; nothing was changed.` }
    this.primed.clear()
    for (const [key] of this.consumed) if (key.endsWith(roomId)) this.consumed.delete(key)
    for (const [sessionId] of this.queue) this.queue.delete(sessionId)
    return { ok: true, deleted: true, message: `room ${roomId} deleted, with its messages, images and boards. This is not reversible.` }
  }

  /** Members that hold a session id (label-only rows cannot receive mail). */
  membersOf(room: Room): RoomMember[] {
    return room.members.filter(member => typeof member.sessionId === 'string' && member.sessionId !== '')
  }

  /** Every room this session belongs to. */
  async roomsFor(sessionId: string): Promise<Room[]> {
    if (sessionId === '') return []
    const rooms = await this.list()
    return rooms.filter(room => room.members.some(member => member.sessionId === sessionId))
  }

  // ----------------------------------------------------------------- post --
  /**
   * Post one message. Images are validated + copied first and every refused
   * source is listed in the outcome, never dropped silently. Then live members
   * get the wake disposition; offline members keep it unread.
   */
  async post(input: PostInput): Promise<PostOutcome> {
    if (!this.enabled) return { ok: false, message: 'rooms are disabled by config (rooms.enabled = false)' }
    const room = await this.get(input.roomId)
    if (room === undefined) return { ok: false, message: `no such room: ${neutralize(input.roomId)}` }
    // Membership is what authorizes a write, exactly as it authorizes a read:
    // a session that has not joined cannot put words into a room's transcript.
    // `fromKind: 'system'` rows (join notices, delegation write-back) carry no
    // author session and are written by this plugin, so they are not gated.
    if (input.fromSessionId !== undefined && !room.members.some(member => member.sessionId === input.fromSessionId)) {
      return { ok: false, message: `session ${input.fromSessionId} is not a member of ${room.id}; call cortex_room_join {roomId} first.` }
    }
    const text = typeof input.text === 'string' ? input.text : ''
    const refused: string[] = []
    const stored: string[] = []
    for (const source of input.images ?? []) {
      const result = await importRoomImage(this.deps.store, room.id, source)
      if (result.ok && result.rel !== undefined) stored.push(result.rel)
      else refused.push(`${neutralize(clampText(String(source), 120))}: ${result.message}`)
    }
    if (text.trim() === '' && stored.length === 0) {
      return { ok: false, message: `nothing to post: the text is empty and no image was accepted${refused.length > 0 ? ` (${refused.join('; ')})` : ''}` }
    }
    const posted = await this.deps.store.postMessage(room.id, {
      text,
      fromKind: input.fromKind ?? 'session',
      ...(input.fromSessionId === undefined ? {} : { fromSessionId: input.fromSessionId }),
      ...(input.fromLabel === undefined ? {} : { fromLabel: input.fromLabel }),
      images: stored,
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    })
    if (!posted.ok || posted.data === null || posted.data === undefined) {
      return { ok: false, message: `post failed: ${posted.error ?? 'unknown'}` }
    }
    const message = posted.data
    await this.touchMember(room, input.fromSessionId)
    let head = `posted seq ${String(message.seq)} to ${room.id}`
    if (refused.length > 0) head = `${head}; refused ${String(refused.length)} image path(s): ${refused.join('; ')}`
    // The author never receives their own mail: move the watermark past it.
    if (input.fromSessionId !== undefined) this.consume(input.fromSessionId, room.id, message.seq)
    if (input.notify === false) return { ok: true, message: head, seq: message.seq, images: stored, ...(refused.length > 0 ? { refused } : {}) }
    const { counts, results } = await this.notifyMembers(room, message, {
      ...(input.fromSessionId === undefined ? {} : { exceptSessionId: input.fromSessionId }),
      ...(input.notifyOnly === undefined ? {} : { only: input.notifyOnly }),
    })
    return {
      ok: true,
      message: `${head}; ${formatCounts(counts, results)}`,
      seq: message.seq,
      images: stored,
      ...(refused.length > 0 ? { refused } : {}),
      counts,
      results,
    }
  }

  /**
   * Deliver one stored message to members. `exceptSessionId` is the author
   * (never mailed); `only` restricts the immediate wake/steer path to those ids
   * — everyone else keeps the message unread, which is what the `cortex:rooms`
   * seam renders at their next turn.
   */
  async notifyMembers(
    room: Room,
    message: RoomMessage,
    options: { exceptSessionId?: string; only?: readonly string[] } = {},
  ): Promise<{ counts: DeliveryCounts; results: DeliveryResult[] }> {
    const { exceptSessionId, only } = options
    const counts = emptyCounts()
    const results: DeliveryResult[] = []
    for (const member of this.membersOf(room)) {
      const sessionId = member.sessionId as string
      if (exceptSessionId !== undefined && sessionId === exceptSessionId) {
        counts.self += 1
        results.push({ sessionId, label: member.label, disposition: 'skip-self', detail: 'author' })
        continue
      }
      if (only !== undefined && !only.includes(sessionId)) {
        // Deferred, not dropped: queued exactly like an offline member, so the
        // `cortex:rooms` seam still renders it at that session's next turn.
        this.enqueue(sessionId, mailFromMessage(message, room.title))
        counts.deferred += 1
        results.push({ sessionId, label: member.label, disposition: 'skip-deferred', detail: 'not an immediate recipient; stays unread' })
        continue
      }
      const mail = mailFromMessage(message, room.title)
      results.push(this.deliverMail(sessionId, member.label, mail))
      const last = results[results.length - 1] as DeliveryResult
      if (last.disposition === 'wake') counts.wake += 1
      else if (last.disposition === 'steer') counts.steer += 1
      else if (last.disposition === 'failed') counts.failed += 1
      else counts.offline += 1
    }
    return { counts, results }
  }

  /**
   * One mail, one target, one decision. The queue is the single ledger: popping
   * before the host call and restoring on a throw keeps "steered" and
   * "rendered by the context seam" mutually exclusive without losing either.
   */
  deliverMail(sessionId: string, label: string, mail: RoomMail): DeliveryResult {
    const agent = this.live(sessionId)
    if (agent === undefined) {
      this.enqueue(sessionId, mail)
      return { sessionId, label, disposition: 'skip-offline', detail: 'kept unread; renders at its next turn' }
    }
    const queued = this.queue.get(sessionId) ?? []
    const index = queued.findIndex(item => item.roomId === mail.roomId && item.seq === mail.seq)
    const popped = index >= 0 ? (queued[index] as RoomMail) : mail
    if (index >= 0) queued.splice(index, 1)
    const running = agent.status === 'running'
    const method = running ? 'steer' : 'followup'
    try {
      const send = agent[method]
      if (typeof send !== 'function') throw new Error(`this host agent exposes no ${method}()`)
      send.call(agent, roomMailMessage([popped], this.root, this.deps.cfg().injectLabel))
      this.consume(sessionId, popped.roomId, popped.seq)
      return { sessionId, label, disposition: running ? 'steer' : 'wake', detail: running ? 'next step boundary' : 'woken' }
    } catch (error) {
      // Put it back: it is still on disk, but dropping it from the queue could
      // mean no later path ever shows it.
      this.enqueue(sessionId, popped, 'front')
      return { sessionId, label, disposition: 'failed', detail: errorMessage(error) }
    }
  }

  // ----------------------------------------------------------- the ledger --
  private watermark(sessionId: string, roomId: string): number {
    return this.consumed.get(ledgerKey(sessionId, roomId)) ?? 0
  }

  /**
   * Record that a session has seen everything up to `seq` in one room. The
   * in-memory move is synchronous (a prompt callback cannot await); the file
   * lands behind it and {@link flushLedger} awaits it.
   */
  consume(sessionId: string, roomId: string, seq: number): void {
    const key = ledgerKey(sessionId, roomId)
    if ((this.consumed.get(key) ?? 0) >= seq) return
    this.consumed.set(key, seq)
    const write = this.persistConsumed(sessionId, roomId, seq)
    this.pendingWrites.add(write)
    void write.finally(() => { this.pendingWrites.delete(write) })
  }

  /** Await every queued watermark write (tests; a shutdown path may too). */
  async flushLedger(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites])
    }
  }

  private async persistConsumed(sessionId: string, roomId: string, seq: number): Promise<void> {
    try {
      const file = consumedFile(this.deps.store, roomId, sessionId)
      await ensureDir(join(file, '..'))
      const row: ConsumedRow = { sessionId, roomId, lastSeq: seq, updatedAt: new Date().toISOString() }
      const written = await this.deps.store.writeStateJson(file, row)
      if (!written.ok) throw new Error(written.error)
    } catch (error) {
      // The in-memory watermark already moved, so at worst this session sees the
      // mail once more after a restart. Reported, never fatal (P4).
      this.warn(`consumed ledger write failed (${roomId}/${sessionId}): ${errorMessage(error)}`)
    }
  }

  private enqueue(sessionId: string, mail: RoomMail, where: 'back' | 'front' = 'back'): void {
    const list = this.queue.get(sessionId) ?? []
    if (list.some(item => item.roomId === mail.roomId && item.seq === mail.seq)) return
    if (where === 'front') list.unshift(mail)
    else list.push(mail)
    // Oldest-first and hard-capped: a session that never reads must not grow
    // this process without bound (P2). Dropped mails stay on disk + in the
    // consumed watermark, so `cortex_room_read` still reaches them.
    while (list.length > QUEUE_MAX) list.shift()
    this.queue.set(sessionId, list)
  }

  /** One session's consumed watermark for one room (missing file = 0). */
  private async readConsumed(sessionId: string, roomId: string): Promise<number> {
    const key = ledgerKey(sessionId, roomId)
    const cached = this.consumed.get(key)
    if (cached !== undefined) return cached
    const row = await readJsonSafe<ConsumedRow | null>(consumedFile(this.deps.store, roomId, sessionId), {
      fallback: null,
      quarantineDir: this.deps.store.paths.quarantine(),
      warn: message => this.warn(message),
    })
    const lastSeq = row !== null && typeof row.lastSeq === 'number' && Number.isFinite(row.lastSeq) ? row.lastSeq : 0
    this.consumed.set(key, lastSeq)
    return lastSeq
  }

  /**
   * Load one session's unread mail from disk into the queue. Idempotent, and
   * the reason a restart does not re-deliver what was already consumed. Returns
   * the number of mails now queued for it.
   */
  async prime(sessionId: string): Promise<number> {
    if (sessionId === '') return 0
    const rooms = await this.roomsFor(sessionId)
    for (const room of rooms) {
      const since = await this.readConsumed(sessionId, room.id)
      const result = await this.deps.store.readMessages(room.id, { sinceSeq: since, limit: QUEUE_MAX * 2 })
      if (!result.ok || result.data === undefined) continue
      for (const message of result.data) {
        if (message.seq <= this.watermark(sessionId, room.id)) continue
        if (message.fromSessionId === sessionId) {
          // Own words: move past them, never show them back.
          this.consume(sessionId, room.id, message.seq)
          continue
        }
        this.enqueue(sessionId, mailFromMessage(message, room.title))
      }
    }
    this.primed.add(sessionId)
    return (this.queue.get(sessionId) ?? []).length
  }

  /** True when this session's ledger has not been read in this process yet. */
  needsPrime(sessionId: string): boolean {
    return !this.primed.has(sessionId)
  }

  /** Unread mails for a session, oldest first, capped to one turn. Sync. */
  take(sessionId: string, max = MAIL_MAX_PER_TURN): { mails: RoomMail[]; more: number } {
    const list = this.queue.get(sessionId) ?? []
    const count = Math.max(0, Math.min(max, list.length))
    this.queue.set(sessionId, list.slice(count))
    return { mails: list.slice(0, count), more: list.length - count }
  }

  /** Put mails back at the head (a render that turned out unwanted). */
  restore(sessionId: string, mails: readonly RoomMail[]): void {
    for (const mail of [...mails].reverse()) this.enqueue(sessionId, mail, 'front')
  }

  /** Unread count per member, for honest `cortex_room_status` output. */
  async unreadCounts(room: Room): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const member of this.membersOf(room)) {
      const sessionId = member.sessionId as string
      const since = await this.readConsumed(sessionId, room.id)
      const result = await this.deps.store.readMessages(room.id, { sinceSeq: since, limit: QUEUE_MAX * 2 })
      const list = result.ok && result.data !== undefined ? result.data : []
      out[sessionId] = list.filter(message => message.fromSessionId !== sessionId).length
    }
    return out
  }

  /** Stored messages of a room, oldest first, limit clamped (P2). */
  async read(roomId: string, options: { sinceSeq?: number; limit?: number } = {}): Promise<{ ok: boolean; message: string; messages: RoomMessage[] }> {
    const room = await this.get(roomId)
    if (room === undefined) return { ok: false, message: `no such room: ${neutralize(roomId)}`, messages: [] }
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100))
    const result = await this.deps.store.readMessages(roomId, { ...options, limit })
    if (!result.ok || result.data === undefined) return { ok: false, message: `read failed: ${result.error ?? 'unknown'}`, messages: [] }
    return { ok: true, message: `${String(result.data.length)} message(s) in "${neutralize(clampText(room.title, 60))}"`, messages: result.data }
  }

  /** Members joined with live state + unread counts (the status surface). */
  async status(roomId: string): Promise<{ ok: boolean; message: string; rows?: Array<Record<string, unknown>>; room?: Room }> {
    const room = await this.get(roomId)
    if (room === undefined) return { ok: false, message: `no such room: ${neutralize(roomId)}` }
    const unread = await this.unreadCounts(room)
    const rows = this.membersOf(room).map(member => {
      const sessionId = member.sessionId as string
      const agent = this.live(sessionId)
      return {
        sessionId,
        label: neutralize(member.label),
        state: this.stateOf(member),
        model: agent?.options?.model ?? member.model ?? null,
        cwd: agent?.session?.header?.cwd ?? member.cwd ?? null,
        unread: unread[sessionId] ?? 0,
        joinedAt: member.joinedAt,
        lastActivityAt: member.lastActivityAt ?? null,
      }
    })
    const labelOnly = room.members.filter(member => typeof member.sessionId !== 'string' || member.sessionId === '')
    return {
      ok: true,
      message: `${String(rows.length)} session member(s), ${String(labelOnly.length)} label-only${labelOnly.length > 0 ? ` (${labelOnly.map(member => neutralize(member.label)).join(', ')})` : ''}; last seq ${String(room.lastSeq)}`,
      rows,
      room,
    }
  }

  // --------------------------------------------------------- render edges --
  /**
   * The injected block for one session, called by the `cortex:rooms` prompt
   * context. Whatever it returns is consumed (popped + watermark moved), so the
   * next turn cannot render the same mail. '' when there is nothing to say.
   */
  renderFor(sessionId: string | undefined): string {
    if (sessionId === undefined || sessionId === '' || !this.enabled) return ''
    const { mails, more } = this.take(sessionId)
    if (mails.length === 0) return ''
    const block = renderMailBlock(mails, this.root, more, this.deps.cfg().injectLabel)
    // Only what was actually rendered is consumed; a message the character
    // budget dropped stays unread for the next turn (P2 + honesty).
    const kept = new Set(block.deliveredSeqs.map(item => seqKey(item.roomId, item.seq)))
    const dropped = mails.filter(mail => !kept.has(seqKey(mail.roomId, mail.seq)))
    if (dropped.length > 0) this.restore(sessionId, dropped)
    for (const item of block.deliveredSeqs) this.consume(sessionId, item.roomId, item.seq)
    return block.text
  }

  /** One compact line per room, for `cortex_room_list`. */
  formatRoomLine(room: Room): string {
    const members = this.membersOf(room)
    const states = members.map(member => `${neutralize(clampText(member.label, 30))}=${this.stateOf(member)}`).join(' ')
    return `- ${room.id} "${neutralize(clampText(room.title, 60))}" - ${String(members.length)} member(s)${states === '' ? '' : ` - ${states}`} - seq ${String(room.lastSeq)}`
  }

  /**
   * Release the in-memory ledger and this instance's entry in the process-level
   * cache (F10): without this, a superseded boot handed its queue, its primed
   * marks and its captured `deps` to the next one. The durable record — room
   * files, messages and the consumed watermarks under `rooms/<id>/consumed/` —
   * is untouched, so the next boot re-primes from disk, and host-owned handles
   * (live agents/sessions) are never touched here. The cache delete is
   * identity-guarded so a late release cannot evict a newer instance.
   */
  dispose(): void {
    this.queue.clear()
    this.consumed.clear()
    this.primed.clear()
    if (instances.get(this.root) === this) instances.delete(this.root)
  }
}

const instances = new Map<string, RoomService>()

/**
 * The one service per state root (see the class doc). Tests that want a clean
 * queue build a fresh temp root, which yields a fresh instance; `reset` exists
 * for the rare case of reusing a root inside one process.
 */
export function roomsService(deps: ModuleDeps): RoomService {
  const existing = instances.get(deps.store.root)
  if (existing !== undefined) return existing
  const created = new RoomService(deps)
  instances.set(deps.store.root, created)
  return created
}

/** Drop the cached service for one root (tests / hot-reload hygiene). */
export function resetRoomsService(root: string): void {
  instances.delete(root)
}
