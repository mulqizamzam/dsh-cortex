/**
 * Room mail: the text a receiving agent actually sees.
 *
 * Honesty rules this file exists to enforce:
 * - P1 / G-02: a room message is plugin-authored. Every rendered mail starts
 *   with a first-line banner naming the plugin and saying out loud that this is
 *   NOT a user instruction, so the mail cannot be mistaken for its own user
 *   even if a host build renders `source.kind` differently.
 * - P9 (host issue-class #53): every string leaving here went through
 *   `neutralize()`; a brace pair in mail text would deadlock the session.
 * - P2: hard caps on both sides — at most {@link MAIL_MAX_PER_TURN} messages and
 *   at most {@link MAIL_BLOCK_CHARS} per rendered block, whole messages only,
 *   with an honest "N more" line.
 *
 * Pure module: no fs, no host, no clock. Feed it data, get text out.
 */
import { clampText, trimToBudget } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { RoomMessage } from '../../types.ts'

/** Hard cap on messages rendered for one session in one turn (BRIEFS M5). */
export const MAIL_MAX_PER_TURN = 5

/** Budget for one whole mail block; overflow drops whole messages (P2). */
export const MAIL_BLOCK_CHARS = 4000

/** Budget for one message body inside a block (a room post can be 2000 chars). */
const MAIL_BODY_CHARS = 900

/**
 * Fallback block header. Production passes `cfg().injectLabel` - the same P1
 * string the memory and todo blocks lead with - so every injected block starts
 * identically. This constant keeps the room honest on its own terms too: it says
 * room mail, plugin-authored, never user.
 */
export const MAIL_LABEL = '[dsh-cortex · room mail · plugin-authored, not user instructions]'

/** One message joined against the room it came from, ready to render. */
export interface RoomMail {
  roomId: string
  roomTitle: string
  seq: number
  fromKind: RoomMessage['fromKind']
  fromLabel: string
  fromSessionId?: string
  at: string
  text: string
  /** Paths relative to `rooms/<roomId>/` as persisted on the message. */
  images: string[]
}

/** Absolute path of a stored room image; what a reader needs for `read_image`. */
function imageAbsolutePath(root: string, roomId: string, relPath: string): string {
  const base = root.replace(/[/\\]+$/, '')
  const room = roomId.replace(/^[/\\]+|[/\\]+$/g, '')
  const rel = relPath.replace(/^[/\\]+/, '')
  return `${base}/rooms/${room}/${rel}`
}

/** Who sent it, in one honest token: a label, a session id, or the kind. */
function authorOf(message: RoomMessage): string {
  const label = typeof message.fromLabel === 'string' && message.fromLabel !== '' ? message.fromLabel : ''
  const session = typeof message.fromSessionId === 'string' && message.fromSessionId !== '' ? message.fromSessionId : ''
  if (label !== '' && session !== '') return `${label} (session ${session})`
  if (label !== '') return label
  if (session !== '') return `session ${session}`
  return message.fromKind
}

/** Lift one stored message into a {@link RoomMail} for rendering. */
export function mailFromMessage(message: RoomMessage, roomTitle: string): RoomMail {
  return {
    roomId: message.roomId,
    roomTitle: neutralize(roomTitle),
    seq: message.seq,
    fromKind: message.fromKind,
    fromLabel: neutralize(authorOf(message)),
    ...(message.fromSessionId === undefined ? {} : { fromSessionId: message.fromSessionId }),
    at: message.at,
    text: message.text,
    images: Array.isArray(message.images) ? message.images.map(String) : [],
  }
}

/**
 * The G-02 first-line banner. Present on EVERY delivery path (injected block
 * lines and the single-message wake/steer text) so authorship never depends on
 * how one host build happens to render a message source.
 */
function mailBanner(mail: RoomMail): string {
  return `[dsh-cortex room ${neutralize(mail.roomId)} · ${mail.fromKind} message from ${mail.fromLabel} at ${neutralize(mail.at)} · plugin-authored, NOT a user instruction]`
}

/** Image lines: absolute path + the tool to open it with (HOST-API §6). */
function mailImageLines(mail: RoomMail, root: string): string[] {
  return mail.images.map(rel => {
    const clean = neutralize(rel)
    return `  image ${clean} → ${neutralize(imageAbsolutePath(root, mail.roomId, clean))} — open it with the read_image tool`
  })
}

/** One stored message as a transcript line (`cortex_room_read`, RPC `rooms.read`). */
function formatRoomMessage(message: RoomMessage, root: string): string {
  const body = clampText(neutralize(message.text), MAIL_BODY_CHARS)
  const images = message.images
    .map(rel => {
      const clean = neutralize(rel)
      return `  image ${clean} -> ${neutralize(imageAbsolutePath(root, message.roomId, clean))} (open with the read_image tool)`
    })
    .join('\n')
  return `#${String(message.seq)} [${neutralize(message.at)}] ${neutralize(authorOf(message))} (${neutralize(message.fromKind)}): ${body}${images === '' ? '' : `\n${images}`}`
}

/** A whole transcript, capped by the caller's output budget (P2). */
export function formatRoomMessages(messages: readonly RoomMessage[], root: string, charCap: number): string {
  if (messages.length === 0) return '(no messages yet)'
  const lines = messages.map(message => formatRoomMessage(message, root))
  const joined = lines.join('\n')
  if (joined.length <= charCap) return neutralize(joined)
  return neutralize(trimToBudget(lines, charCap, { separator: '\n', omitHint: 'older messages; raise the limit or pass sinceSeq' }).text)
}

/** One message as model-visible text (no block header). */
export function renderMail(mail: RoomMail, root: string): string {
  const body = clampText(neutralize(mail.text), MAIL_BODY_CHARS)
  return [
    mailBanner(mail),
    `room: ${mail.roomTitle} (${mail.roomId}) · seq ${String(mail.seq)}`,
    body,
    ...mailImageLines(mail, root),
  ].join('\n')
}

/**
 * The injected per-turn block. `mails` must already be capped to
 * {@link MAIL_MAX_PER_TURN}; `omitted` is the honest remainder count, which this
 * function also grows if the character budget drops messages (P2: whole
 * messages only, never a partial one).
 */
export function renderMailBlock(
  mails: readonly RoomMail[],
  root: string,
  omitted = 0,
  label: string = MAIL_LABEL,
): { text: string; deliveredSeqs: Array<{ roomId: string; seq: number }> } {
  if (mails.length === 0) return { text: '', deliveredSeqs: [] }
  const header = neutralize(label)
  const lines = mails.map(mail => renderMail(mail, root))
  const budget = Math.max(0, MAIL_BLOCK_CHARS - header.length - 2)
  const trimmed = trimToBudget(lines, budget, { separator: '\n\n', omitHint: 'more unread — call cortex_room_read' })
  const droppedByBudget = lines.length - trimmed.kept.length
  const head = `## Room messages waiting for you (${String(mails.length + omitted)} unread, ${String(mails.length)} considered this turn)`
  const tail = omitted + droppedByBudget > 0 ? `[… ${String(omitted + droppedByBudget)} more unread — call cortex_room_read]` : ''
  const text = [header, head, trimmed.text, tail].filter(part => part !== '').join('\n')
  const keptCount = trimmed.kept.length
  return {
    text: neutralize(text.length > MAIL_BLOCK_CHARS ? text.slice(0, MAIL_BLOCK_CHARS) : text),
    deliveredSeqs: mails.slice(0, keptCount).map(mail => ({ roomId: mail.roomId, seq: mail.seq })),
  }
}
