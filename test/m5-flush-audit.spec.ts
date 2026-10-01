/**
 * M5 audit — StreamSink.flush write-amplification.
 *
 * Contract (runner.ts lines 54-69), pinned here because the interval change
 * (250 → 1000 ms) must not move any of it:
 *   - tail-capped: at most capBytes retained, older bytes dropped, marker
 *     line HEAD_DROPPED prefixed when the cap has ever been tripped
 *   - persisted by atomic full-file rewrite: persist(path, text) is a full
 *     write, never an append
 *   - flushes are time-throttled; only a dirty buffer is written
 *   - `dirty` is cleared BEFORE persist; a failed flush is lost, the final
 *     flush at settle is the recovery point
 *   - disk failures are swallowed here; they must not kill the child
 *   - forced flush bypasses the throttle entirely
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamSink } from '../src/host/modules/delegate/runner.ts'

const CAP = 1024 * 1024 // delegation.outputCapBytes default
const MARKER = '[… head dropped — output exceeded the per-stream cap …]\n'

afterEach(() => {
  vi.useRealTimers()
})

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'm5-flush-'))
}

function countingPersist(dir: string, file: string): {
  persist: (f: string, text: string) => Promise<{ ok: boolean; error?: string }>
  writes: () => number
  totalBytes: () => number
  lastContent: () => string
} {
  let count = 0
  let totalBytes = 0
  let last = ''
  return {
    async persist(target, text) {
      count += 1
      totalBytes += Buffer.byteLength(text, 'utf8')
      last = text
      await writeFile(join(dir, target === file ? 'stdout.log' : 'stderr.log'), text)
      return { ok: true }
    },
    writes: () => count,
    totalBytes: () => totalBytes,
    lastContent: () => last,
  }
}

describe('M5 flush interval 1000 ms — throttle semantics unchanged', () => {
  it('1. default interval is 1000 ms (not 250): rejected at +999, accepted at +1000', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000_000)
    const dir = await tempDir()
    const { persist, writes } = countingPersist(dir, 'stdout.log')
    const sink = new StreamSink('stdout.log', CAP, persist) // default interval

    sink.push('first chunk')
    await sink.flush(false)
    expect(writes(), 'first non-forced flush lands (lastFlushMs starts at 0)').toBe(1)

    sink.push('second chunk')
    vi.setSystemTime(10_000_999)
    await sink.flush(false)
    expect(writes(), 'at +999 ms the throttle must still reject (250 ms would have written)').toBe(1)

    vi.setSystemTime(10_001_000)
    await sink.flush(false)
    expect(writes(), 'at +1000 ms the throttle must accept').toBe(2)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('2. flush happens after the interval, and only when dirty', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000_000)
    const dir = await tempDir()
    const { persist, writes } = countingPersist(dir, 'stdout.log')
    const sink = new StreamSink('stdout.log', CAP, persist)

    sink.push('a')
    await sink.flush(false)
    expect(writes()).toBe(1)
    // Interval elapsed but nothing arrived: a clean buffer never writes.
    vi.setSystemTime(10_010_000)
    await sink.flush(false)
    expect(writes(), 'clean buffer must not write even after the interval').toBe(1)
    // Something arrived: it writes again.
    sink.push('b')
    await sink.flush(false)
    expect(writes()).toBe(2)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('3. forced/final flush bypasses the throttle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000_000)
    const dir = await tempDir()
    const { persist, writes } = countingPersist(dir, 'stdout.log')
    const sink = new StreamSink('stdout.log', CAP, persist)

    sink.push('chunk')
    await sink.flush(false)
    expect(writes()).toBe(1)
    // Zero ms later: the throttle would reject, force must not.
    sink.push('more chunk')
    await sink.flush(true)
    expect(writes(), 'a forced flush must ignore the interval').toBe(2)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('4. persist failure is swallowed and does not poison the sink', async () => {
    const dir = await tempDir()
    let calls = 0
    const persist = async (): Promise<{ ok: boolean; error?: string }> => {
      calls += 1
      return { ok: false, error: 'ENOSPC' }
    }
    const sink = new StreamSink('stdout.log', CAP, persist)
    sink.push('data'.repeat(1000))
    await expect(sink.flush(true)).resolves.toBeUndefined()
    expect(calls).toBe(1)
    // `dirty` was cleared before persist: no implicit retry; a new push
    // makes it dirty again and the next flush writes.
    sink.push('more'.repeat(1000))
    await sink.flush(true)
    expect(calls).toBe(2)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('5a. cap + HEAD_DROPPED unchanged: marker only after the cap actually trips', async () => {
    const dir = await tempDir()
    const { persist, lastContent } = countingPersist(dir, 'stdout.log')
    const sink = new StreamSink('stdout.log', CAP, persist)
    sink.push('under the cap'.repeat(100))
    await sink.flush(true)
    expect(lastContent(), 'no marker while under the cap').not.toContain('head dropped')

    sink.push('x'.repeat(CAP))
    await sink.flush(true)
    const content = lastContent()
    expect(content.startsWith(MARKER), 'marker exactly once, at the head').toBe(true)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(CAP + Buffer.byteLength(MARKER))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('5b. persist still receives a full rewrite of content() (no append)', async () => {
    const dir = await tempDir()
    const { persist, totalBytes, lastContent } = countingPersist(dir, 'stdout.log')
    const sink = new StreamSink('stdout.log', CAP, persist)
    for (let i = 0; i < 10; i += 1) sink.push(`line-${i}\n`.padStart(4096, 'x'))
    await sink.flush(true)
    await sink.flush(true) // dirty again only after a push; no-op here
    const one = Buffer.byteLength(lastContent(), 'utf8')
    expect(totalBytes(), 'a second flush with no push writes nothing').toBe(one)
    expect(one).toBe(Buffer.byteLength(sink.content(), 'utf8'))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
})

describe('M5 benchmark: pump cadence 250 ms (old) vs 1000 ms default (new)', () => {
  it('10 s of a chatty job at the runner pump cadence (500 ms checks)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const dir = await tempDir()

    const run = async (interval?: number): Promise<{ writes: number; mb: number }> => {
      vi.setSystemTime(10_000_000)
      const { persist, writes, totalBytes } = countingPersist(dir, 'stdout.log')
      const sink = interval === undefined
        ? new StreamSink('stdout.log', CAP, persist)
        : new StreamSink('stdout.log', CAP, persist, interval)
      // 10 seconds of output: a 4 KiB chunk every 25 ms; the runner's pump
      // calls non-forced flush() every 500 ms.
      for (let tick = 0; tick < 400; tick += 1) {
        sink.push('q'.repeat(4096))
        vi.setSystemTime(10_000_000 + tick * 25)
        if (tick % 20 === 0) await sink.flush(false) // pump: every 500 ms
      }
      await sink.flush(true) // the settle flush
      return { writes: writes(), mb: totalBytes() / 1024 / 1024 }
    }

    const oldInterval = await run(250)
    const newInterval = await run() // default 1000
    console.log(
      `BENCH pump 10s chatty: old 250 ms -> ${String(oldInterval.writes)} writes / ${oldInterval.mb.toFixed(1)} MiB, ` +
      `new default 1000 ms -> ${String(newInterval.writes)} writes / ${newInterval.mb.toFixed(1)} MiB`,
    )
    // The new default writes less; the settle (final) flush is identical.
    expect(newInterval.writes).toBeLessThan(oldInterval.writes)
    expect(newInterval.mb).toBeLessThan(oldInterval.mb)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('the final settle flush is unchanged: last content is byte-identical either way', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const dir = await tempDir()
    const settleContent = async (interval: number): Promise<string> => {
      vi.setSystemTime(10_000_000)
      const { persist, lastContent } = countingPersist(dir, 'stdout.log')
      const sink = new StreamSink('stdout.log', CAP, persist, interval)
      for (let tick = 0; tick < 400; tick += 1) {
        sink.push(`chunk-${tick}\n`.padEnd(4096, 'x'))
        vi.setSystemTime(10_000_000 + tick * 25)
        if (tick % 20 === 0) await sink.flush(false)
      }
      await sink.flush(true)
      return lastContent()
    }
    const old = await settleContent(250)
    const neu = await settleContent(1000)
    expect(neu, 'interval must not change what a reader finally sees').toBe(old)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
})
