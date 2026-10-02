/**
 * The delegate module's only process/filesystem boundary. DESIGN §8-M6 makes
 * CLI spawn M6's own job ("delegation spawn" is explicitly NOT a store
 * primitive), so `node:child_process` appears here and nowhere else in M2..M6
 * — and `node:fs/promises` only for `copyFile`, because src/lib has no binary
 * copy primitive and room-style image copies cannot go through the utf-8
 * text helpers. Every other byte touches lib/fsx.
 *
 * P7: `spawn(exe, args, { shell: false })` — argv arrays end to end, task text
 * reaches the child only as ONE argv item or as a file path (service.ts), the
 * env is a plain object, cwd is the plugin state root. There is no code path
 * from here to a shell string.
 */
import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { copyFile, open } from 'node:fs/promises'
import { basename } from 'node:path'
import { readTextSafe, sizeOf } from '../../../lib/fsx.ts'
import { errorMessage } from '../../../lib/errors.ts'

export type RunStatus = 'succeeded' | 'failed' | 'killed' | 'timeout'

export interface RunOutcome {
  status: RunStatus
  exitCode: number | null
  error?: string
}

export interface RunOptions {
  /** Full argv; item 0 is the executable. Non-empty, validated upstream. */
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Hard wall-clock limit; on expiry the whole process group is killed. */
  timeoutMs: number
  /** Tail-capped persist targets (flushed atomically, see StreamSink). */
  stdoutFile: string
  stderrFile: string
  capBytes: number
  /** Grace between SIGTERM and SIGKILL of the process group. */
  killGraceMs?: number
  /** State-root writer (store seam): the sink must not bypass the schema gate. */
  persist: (file: string, text: string) => Promise<{ ok: boolean; error?: string }>
}

export interface RunningJob {
  /** OS pid once spawned; undefined until the 'spawn' event fires. */
  pid: number | undefined
  outcome: Promise<RunOutcome>
  /** Request cancellation (settles the outcome as 'killed'). */
  cancel: () => void
}

/**
 * Stream capture with a hard byte cap. The child's output can be hostile or
 * simply endless (P2), so the sink keeps at most `capBytes` in memory —
 * dropping the HEAD once the cap trips — and persists by atomic full-file
 * rewrite (the store exposes no append primitive; a crash costs the last
 * flush window, which is documented in the module report). Flushes are
 * time-throttled so a chatty runner cannot turn every chunk into a rewrite.
 *
 * The cap is enforced INCREMENTALLY: `push` runs synchronously inside the
 * child's `data` handler, so its cost is the host event loop's cost. The
 * buffer is a queue of chunks plus a running UTF-8 byte total — never
 * re-measured — and trimming drops whole leading chunks and byte-slices at
 * most one, so a push is O(chunk) instead of O(cap). (The previous shape ran
 * `Buffer.byteLength` over the whole buffer per chunk plus a binary search of
 * full re-measures: measured 11,648 ms of synchronous CPU for 100 MB of
 * 64 KiB chunks against a 1 MiB cap.)
 */
export class StreamSink {
  /** Untrimmed chunks, oldest first. Dropped from the front once the cap trips. */
  private parts: string[] = []
  /** UTF-8 byte length of the whole queue. */
  private bytes = 0
  private overflowed = false
  private dirty = false
  private lastFlushMs = 0
  /** The persist write currently running, if any (M5 race B). */
  private inflight: Promise<void> | null = null
  private readonly flushIntervalMs: number

  constructor(
    private readonly file: string,
    private readonly capBytes: number,
    private readonly persist: (file: string, text: string) => Promise<{ ok: boolean; error?: string }>,
    flushIntervalMs = 1000,
  ) {
    this.flushIntervalMs = Math.max(50, flushIntervalMs)
  }

  push(chunk: string): void {
    if (chunk === '') return
    this.parts.push(chunk)
    this.bytes += Buffer.byteLength(chunk, 'utf8')
    if (this.bytes > this.capBytes) this.trim()
    this.dirty = true
  }

  /**
   * Drop the oldest bytes until the queue fits `capBytes` minus the marker it
   * will have to prefix. Whole chunks leave the queue without being copied;
   * the one straddling boundary is sliced on a byte-Buffer, then re-decoded
   * with a bounded repair step so a cut codepoint can never surface as U+FFFD.
   */
  private trim(): void {
    const keep = Math.max(0, this.capBytes - Buffer.byteLength(HEAD_DROPPED, 'utf8'))
    while (this.parts.length > 1 && this.bytes > keep) {
      const head = this.parts[0] as string
      const headBytes = Buffer.byteLength(head, 'utf8')
      if (this.bytes - headBytes >= keep) {
        this.parts.shift()
        this.bytes -= headBytes
        continue
      }
      // Partial drop: keep the tail of the head chunk.
      const drop = this.bytes - keep
      this.parts[0] = sliceBytesFromEnd(head, drop)
      this.bytes -= drop
      break
    }
    // A single oversized chunk can still exceed `keep`; clamp it.
    if (this.bytes > keep) {
      const only = this.parts[0] ?? ''
      this.parts[0] = sliceBytesFromEnd(only, this.bytes - keep)
      this.bytes = keep
    }
    this.overflowed = true
  }

  content(): string {
    const body = this.parts.length === 1 ? (this.parts[0] as string) : this.parts.join('')
    return this.overflowed ? HEAD_DROPPED + body : body
  }

  /**
   * Persist when the throttle allows; force always writes when dirty.
   *
   * Completion means the file is ON DISK, so a write already in flight is
   * awaited first. The old shape cleared `dirty` at the start of the write and
   * returned for the settle call while that write was still pending, so
   * `finalize` could compose result.md from a stdout file that had not landed
   * yet (reproduced on PRE-M5 code: result.md reporting "stdout was empty",
   * .dev/flake2/prec-28.log). A push that arrives during the in-flight write
   * re-marks the buffer dirty, so the awaited flush then writes it too — no
   * lost data, and no second caller can observe a half-finished file.
   */
  async flush(force = false): Promise<void> {
    const pending = this.inflight
    if (pending !== null) await pending
    if (!this.dirty) return
    const now = Date.now()
    if (!force && now - this.lastFlushMs < this.flushIntervalMs) return
    this.dirty = false
    this.lastFlushMs = now
    const write = (async (): Promise<void> => {
      try {
        // `content()` is read synchronously, before persist's first await, so
        // the bytes of a write cannot mix with a later push.
        const written = await this.persist(this.file, this.content())
        if (!written.ok) throw new Error(written.error ?? 'stream persist refused')
      } catch {
        // Disk trouble must not kill the child; the final flush or a warn in
        // the service reports it. Swallowing HERE is the only quiet spot.
      }
    })()
    this.inflight = write
    try {
      await write
    } finally {
      if (this.inflight === write) this.inflight = null
    }
  }
}

/**
 * Drop the first `dropBytes` of a utf-8 string, snapped to a codepoint
 * boundary: slicing the byte buffer at an arbitrary offset can land inside a
 * multi-byte character, so after decoding we advance past any leading
 * U+FFFD that such a cut produced. The repair loop is bounded by the longest
 * legal sequence (4 bytes).
 */
export function sliceBytesFromEnd(text: string, dropBytes: number): string {
  const total = Buffer.byteLength(text, 'utf8')
  if (dropBytes <= 0) return text
  if (dropBytes >= total) return ''
  const bytes = Buffer.from(text, 'utf8')
  let start = dropBytes
  let sliced = bytes.subarray(start).toString('utf8')
  // A cut inside a codepoint decodes to U+FFFD at the head; skip those bytes.
  let guard = 0
  while (sliced.startsWith('�') && guard < 4) {
    start += 1
    sliced = bytes.subarray(start).toString('utf8')
    guard += 1
  }
  return sliced
}

export const HEAD_DROPPED = '[… head dropped — output exceeded the per-stream cap …]\n'

/** Last `bytes` of a utf-8 string, snapped to a char boundary by slicing the
 * string, not the buffer — a torn codepoint would corrupt the tail. */
export function tailByBytes(text: string, bytes: number): string {
  if (bytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (Buffer.byteLength(text.slice(mid), 'utf8') < bytes) high = mid
    else low = mid + 1
  }
  return text.slice(low)
}

/**
 * Read the TAIL of a job log file without reading (or decoding) the whole file.
 *
 * Byte-for-byte equivalent to `tailByBytes(await readTextSafe(file), tailBytes)`
 * for a valid-UTF-8 file — which is every file this plugin writes
 * (`StreamSink.persist` -> `writeTextAtomic`, tmp + rename) — including the two
 * quirks a naive tail would miss:
 *   - the cut is STRICTLY under the budget: an 8193 B file at tailBytes 8192
 *     yields an 8191 B suffix (two head bytes gone, not one);
 *   - the cut is a UTF-16 index, so when an astral pair starts EXACTLY at
 *     `size - tailBytes` the full-decode result starts with a lone low
 *     surrogate; an offset read reproduces that instead of U+FFFD.
 *
 * Mechanics: open once and stat that fd, so the size and the bytes come from
 * one atomic view (the writer rewrites by rename, so an fd never sees a torn
 * file). Small files (size <= tailBytes) are read whole through the same fd
 * and pushed through the original formula. Larger files read only the last
 * `tailBytes + 4` bytes (4 = the longest UTF-8 sequence: alignment slack for
 * the cut). A short read (the file shrank) falls back to the full, original
 * path rather than guessing. ENOENT answers the empty shape without a warning,
 * exactly like `readTextSafe`.
 *
 * Declared deviation: a file that is NOT valid UTF-8 (nothing in this plugin
 * can write one) — `readFile('utf8')` decodes it with replacement characters,
 * so its re-encoded byte length differs from the file size that this function
 * measures; the two implementations can then disagree.
 */
export async function readTailFile(
  file: string,
  tailBytes: number,
  warn?: (message: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const unreadable = (error: unknown): void => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn?.(`${basename(file)}: unreadable (${errorMessage(error)})`)
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch (error) {
    unreadable(error)
    return { text: '', truncated: false }
  }
  try {
    const size = (await handle.stat()).size
    if (tailBytes <= 0) return { text: '', truncated: size > 0 }
    if (size <= tailBytes) {
      // Small path: identical to the original implementation (a fresh handle
      // reads from offset 0), quirks included.
      const raw = await handle.readFile('utf8')
      const text = tailByBytes(raw, tailBytes)
      return { text, truncated: Buffer.byteLength(raw, 'utf8') > Buffer.byteLength(text, 'utf8') }
    }

    // size > tailBytes: read only the window that can contain the cut.
    const position = Math.max(0, size - tailBytes - 4)
    const length = size - position
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead < length) {
      // Shrank under this fd (nothing in the plugin does that; a defensive
      // fallback keeps the answer self-consistent instead of guessing).
      const raw = (await readTextSafe(file, warn)) ?? ''
      const text = tailByBytes(raw, tailBytes)
      return { text, truncated: Buffer.byteLength(raw, 'utf8') > Buffer.byteLength(text, 'utf8') }
    }

    const at = size - tailBytes // the exact position the full-decode oracle cuts around
    const index = at - position
    const lead = buffer[index] ?? 0
    // Case B: an astral pair starting exactly at `at` splits at the mid-pair
    // UTF-16 index in the oracle; reproduce the lone low surrogate it yields.
    if (index + 4 <= bytesRead && lead >= 0xf0 && lead <= 0xf4) {
      const pair = buffer.subarray(index, index + 4).toString('utf8')
      const low = pair.charCodeAt(1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        const rest = buffer.subarray(index + 4).toString('utf8')
        return { text: String.fromCharCode(low) + rest, truncated: true }
      }
    }
    // Case A: first UTF-16 index whose suffix is strictly under the budget is
    // the first codepoint boundary at or after `size - tailBytes + 1`; in bytes
    // that is the first non-continuation byte from that offset.
    let cut = at + 1 - position
    if (cut < 0) cut = 0
    while (cut < bytesRead && ((buffer[cut] ?? 0) & 0xc0) === 0x80) cut += 1
    return { text: buffer.subarray(cut).toString('utf8'), truncated: true }
  } catch (error) {
    unreadable(error)
    return { text: '', truncated: false }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Copy one already-validated image into the job dir; returns the destination. */
export async function copyImage(src: string, dest: string, maxBytes: number): Promise<string> {
  const size = await sizeOf(src)
  if (size === null) throw new Error('image not readable')
  if (size > maxBytes) throw new Error(`image exceeds ${String(maxBytes)} bytes`)
  await copyFile(src, dest)
  return dest
}

export function runProcess(options: RunOptions): RunningJob {
  const stdout = new StreamSink(options.stdoutFile, Math.max(1024, options.capBytes), options.persist)
  const stderr = new StreamSink(options.stderrFile, Math.max(1024, options.capBytes), options.persist)
  const [exe = '', ...args] = options.argv

  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    child = spawn(exe, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // Own process group, so a timeout/cancel reaches grandchildren too
      // (killTree below). Windows has no groups — plain kill there.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return {
      pid: undefined,
      outcome: Promise.resolve({ status: 'failed', exitCode: null, error: `spawn failed: ${errorMessage(error)}` }),
      cancel: () => {},
    }
  }

  const pid = child.pid
  let intent: 'running' | 'killed' | 'timeout' = 'running'
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined

  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (pid !== undefined && process.platform !== 'win32') process.kill(-pid, signal)
      else child.kill(signal)
    } catch {
      // ESRCH: the group is already gone — exactly what we wanted.
    }
  }

  const flushAll = async (): Promise<void> => {
    await Promise.all([stdout.flush(true), stderr.flush(true)])
  }

  const outcome = new Promise<RunOutcome>((resolve) => {
    const settle = (result: RunOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      void flushAll().then(() => resolve(result), () => resolve(result))
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const pump = (sink: StreamSink, throttle: { last: number }) => (chunk: string): void => {
      sink.push(chunk)
      const now = Date.now()
      if (now - throttle.last >= 500) {
        throttle.last = now
        void sink.flush()
      }
    }
    child.stdout.on('data', pump(stdout, { last: 0 }))
    child.stderr.on('data', pump(stderr, { last: 0 }))

    timer = setTimeout(() => {
      if (settled) return
      intent = 'timeout'
      killTree('SIGTERM')
      graceTimer = setTimeout(() => killTree('SIGKILL'), options.killGraceMs ?? 2000)
    }, Math.max(1, options.timeoutMs))
    timer.unref?.()

    child.on('error', (error) => {
      // ENOENT/EACCES arrive HERE (async), never from the spawn() return —
      // the exit code is null and the message is the honest one.
      settle({ status: 'failed', exitCode: null, error: `spawn failed: ${errorMessage(error)}` })
    })

    child.on('close', (code, signal) => {
      if (intent === 'killed') settle({ status: 'killed', exitCode: code, error: signal === null ? undefined : `killed via ${signal}` })
      else if (intent === 'timeout') settle({ status: 'timeout', exitCode: code, error: `timed out after ${String(Math.round(options.timeoutMs / 1000))}s` })
      else if (code === 0) settle({ status: 'succeeded', exitCode: 0 })
      else settle({ status: 'failed', exitCode: code, error: signal === null ? `exit code ${String(code)}` : `terminated by ${signal}` })
    })
  })

  return {
    pid,
    outcome,
    cancel: () => {
      if (settled) return
      intent = 'killed'
      killTree('SIGTERM')
      graceTimer = setTimeout(() => killTree('SIGKILL'), options.killGraceMs ?? 1000)
      graceTimer.unref?.()
    },
  }
}
