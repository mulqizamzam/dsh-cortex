/**
 * Room images (HOST-API §6, DESIGN §2).
 *
 * Threat model, stated plainly: an agent calling `cortex_room_post` controls the
 * `images` strings. Copying whatever path it names would let any session with
 * the tool exfiltrate `~/.ssh/id_rsa` into a room transcript that a second
 * session then reads with `read_image`. So v1 accepts ONE source shape:
 *
 *   an ABSOLUTE path inside the plugin state root
 *
 * which in practice means a file the caller first placed under
 * `<root>/rooms/<roomId>/inbox/` (this module creates that directory and leaves
 * a README saying exactly that). Everything else — relative paths, `..`
 * escapes, `~`, and any absolute path outside the root, INCLUDING a host
 * attachment directory — is refused with a sentence that says what to do
 * instead.
 *
 * DEVIATION from `.dev/BRIEFS.md` §M5 (which also allowed "the host's readable
 * attachment dir"): that needs a configurable prefix and `RoomsConfig` is a
 * shared type this module does not own, so v1 is strictly state-root-only.
 * TODO(PARENT): add `rooms.imageSourceDirs: string[]` to config + types and this
 * file gains one extra containment check.
 *
 * Filesystem use: `src/lib` exports no binary copy primitive, so `copyFile` is
 * imported here directly — the same narrow exception M6 documents at the top of
 * `modules/delegate/runner.ts`. `store.saveRoomImage` is named in
 * `.dev/M0-NOTES.md` §1.4 but is NOT defined in `src/host/store.ts`, so the copy
 * lives here. TODO(PARENT): move it to the store (naming, quota accounting) and
 * call it from `importRoomImage`. Writes stay inside the state root (P5).
 */
import { copyFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { sizeOf } from '../../../lib/fsx.ts'
import { errorMessage } from '../../../lib/errors.ts'
import { ensureDir } from '../../../lib/home.ts'
import { isSafeKey, newId } from '../../../lib/ids.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { CortexStore } from '../../store.ts'

/** DESIGN §2: 8 MiB per image. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** Whitelisted raster types, by extension (DESIGN §2 "tipe whitelist"). */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']

/** Maximum accepted image paths in one post (store also slices to 8). */
export const IMAGE_MAX_PER_POST = 8

/** Where a caller puts a file so it may be posted from. Created on room create. */
export function roomInboxDir(store: CortexStore, roomId: string): string {
  return join(store.paths.room(roomId), 'inbox')
}

/** `images/<file>` — the form persisted on a message (relative, DESIGN §2). */
function roomImageRelPath(file: string): string {
  return `images/${basename(file)}`
}

export interface ImageCheck {
  ok: boolean
  /** Absolute destination inside `rooms/<roomId>/images/`. */
  dest?: string
  /** Destination relative to `rooms/<roomId>/` — what the message stores. */
  rel?: string
  bytes?: number
  /** A sentence: why it was refused, or what was accepted. */
  message: string
}

/** True when `target` resolves strictly inside `dir` (no `..`, no sibling). */
export function isInside(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Validate one proposed image source: shape, containment, name, type, size.
 * Decision only — it stats, it never copies. Kept separate so a test can assert
 * the containment rule without touching the (slower) copy path.
 */
export async function checkRoomImage(store: CortexStore, roomId: string, input: unknown): Promise<ImageCheck> {
  const refuse = (message: string): ImageCheck => ({ ok: false, message: neutralize(message) })
  if (typeof input !== 'string' || input.trim() === '') return refuse('an image path must be a non-empty string')
  const raw = input.trim()
  if (raw.includes('\0')) return refuse('an image path contains a NUL byte')
  const inbox = roomInboxDir(store, roomId)
  if (!isAbsolute(raw)) {
    return refuse(`image paths must be absolute and inside the plugin state root (${store.root}); got "${raw}". Put the file under ${inbox} first.`)
  }
  const source = resolve(raw)
  if (!isInside(store.root, source)) {
    return refuse(`refused: "${source}" is outside the plugin state root (${store.root}). v1 copies images only from inside the state root (e.g. ${inbox}); user/home paths are not readable by design.`)
  }
  const name = basename(source)
  const stem = name.slice(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length)
  if (!isSafeKey(stem)) return refuse(`unsafe file name "${clampText(name, 80)}": use letters, digits, dash, underscore`)
  const ext = extensionOf(name)
  if (!IMAGE_EXTENSIONS.includes(ext)) return refuse(`image type "${ext === '' ? '(none)' : ext}" is not whitelisted (${IMAGE_EXTENSIONS.join(', ')})`)
  const bytes = await sizeOf(source)
  if (bytes === null) return refuse(`no readable file at "${clampText(source, 160)}"`)
  if (bytes === 0) return refuse(`"${clampText(name, 80)}" is empty`)
  if (bytes > IMAGE_MAX_BYTES) return refuse(`"${clampText(name, 80)}" is ${String(bytes)} bytes; the cap is ${String(IMAGE_MAX_BYTES)} bytes per image`)
  const dest = join(store.paths.roomImages(roomId), `${newId()}-${name}`)
  return {
    ok: true,
    dest,
    rel: roomImageRelPath(dest),
    bytes,
    message: `accepted ${clampText(name, 80)} (${String(bytes)} bytes)`,
  }
}

/**
 * Validate + copy one image into `rooms/<roomId>/images/`. Never throws: every
 * failure comes back as `{ok:false, message}` so a post can report the refusals
 * while still posting the text (DESIGN §4: errors are sentences).
 */
export async function importRoomImage(store: CortexStore, roomId: string, input: unknown): Promise<ImageCheck> {
  if (!isSafeKey(roomId)) return { ok: false, message: `unsafe room id "${clampText(String(roomId), 80)}"` }
  const checked = await checkRoomImage(store, roomId, input)
  if (!checked.ok || checked.dest === undefined || checked.rel === undefined) return checked
  try {
    await ensureDir(join(checked.dest, '..'))
    await copyFile(String(input), checked.dest)
    return { ...checked, message: `copied to ${checked.rel}` }
  } catch (error) {
    return { ok: false, message: `could not store image: ${errorMessage(error)}` }
  }
}

/** Create the inbox directory + its README note (called on room create). */
export async function ensureRoomInbox(store: CortexStore, roomId: string): Promise<string> {
  const dir = roomInboxDir(store, roomId)
  await ensureDir(dir)
  const note = join(dir, 'README.txt')
  if ((await sizeOf(note)) === null) {
    const written = await store.writeStateFile(note, [
      'Drop files here that you want to post into this room.',
      'Then call cortex_room_post with the ABSOLUTE path of the file.',
      '',
      `Only files inside the plugin state root (${store.root}) are copied into the room (v1 rule).`,
      `Whitelisted types: ${IMAGE_EXTENSIONS.join(', ')}. Cap: ${String(IMAGE_MAX_BYTES)} bytes per file, ${String(IMAGE_MAX_PER_POST)} files per message.`,
      '',
    ].join('\n'))
    if (!written.ok) throw new Error(written.error)
  }
  await ensureDir(store.paths.roomImages(roomId))
  return dir
}
