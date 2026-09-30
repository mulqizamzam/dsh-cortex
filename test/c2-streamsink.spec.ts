/**
 * C2 regression: the stream sink's cap must not cost the host event loop.
 *
 * Defect (measured before the fix): `StreamSink.push` re-measured the whole
 * buffer with `Buffer.byteLength` on every chunk and, once the cap tripped,
 * ran a binary search of full re-measures to cut the head. `push` runs
 * synchronously inside the child's `data` handler, so that cost is the host
 * event loop's cost: 100 MB of 64 KiB chunks against a 1 MiB cap took
 * 11,648 ms of synchronous CPU.
 *
 * The cap itself is unchanged and is asserted strictly: the marker appears
 * exactly once, the result never exceeds the cap, the freshest bytes survive,
 * and a cut can never land inside a multi-byte character. The timing
 * assertion is a wide regression guard (fixed ~0.3 s vs broken ~11.6 s) and
 * the measured number is printed.
 */
import { describe, expect, it } from 'vitest'
import { HEAD_DROPPED, StreamSink, tailByBytes } from '../src/host/modules/delegate/runner.ts'

const persist = async (): Promise<{ ok: boolean }> => ({ ok: true })

describe('StreamSink cap', () => {
  it('respects the cap, marks the head dropped once, and keeps the freshest tail', () => {
    const cap = 64 * 1024
    const sink = new StreamSink('/dev/null', cap, persist)
    for (let i = 0; i < 50; i += 1) sink.push(`${String(i).padStart(6, '0')}${'x'.repeat(2000)}\n`)
    const content = sink.content()
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(cap)
    expect(content.startsWith(HEAD_DROPPED)).toBe(true)
    expect(content.split(HEAD_DROPPED)).toHaveLength(2)
    // The newest chunk survives; the oldest is gone.
    expect(content).toContain('000049')
    expect(content).not.toContain('000000')
  })

  it('does not mark anything dropped while the stream fits the cap', () => {
    const sink = new StreamSink('/dev/null', 4096, persist)
    sink.push('small output\n')
    expect(sink.content()).toBe('small output\n')
    expect(sink.content()).not.toContain(HEAD_DROPPED)
  })

  it('never splits a multi-byte character at the trim boundary', () => {
    const cap = 1024
    const sink = new StreamSink('/dev/null', cap, persist)
    // 4-byte code points (emoji): any byte-aligned cut of a run of them can
    // land mid-character, which must not surface as U+FFFD.
    for (let i = 0; i < 400; i += 1) sink.push('🙂'.repeat(50))
    const content = sink.content()
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(cap)
    expect(content).not.toContain('�')
    expect(content.endsWith('🙂')).toBe(true)
  })

  it('treats an empty chunk as a no-op and clamps a single oversized chunk', () => {
    const sink = new StreamSink('/dev/null', 128, persist)
    sink.push('')
    expect(sink.content()).toBe('')
    sink.push('y'.repeat(5000))
    expect(Buffer.byteLength(sink.content(), 'utf8')).toBeLessThanOrEqual(128)
  })

  it('flushes only when dirty and honours the throttle, force always writes', async () => {
    const written: string[] = []
    const sink = new StreamSink('/dev/null', 1024, async (_file, text) => { written.push(text); return { ok: true } }, 100000)
    // Nothing pushed: nothing to flush.
    await sink.flush()
    expect(written).toEqual([])
    sink.push('one')
    // The very first flush is allowed (lastFlushMs starts at 0, so the throttle
    // is already open); a second one inside the window is not.
    await sink.flush()
    expect(written).toEqual(['one'])
    await sink.flush(true)
    expect(written).toEqual(['one'])
    sink.push('two')
    await sink.flush(true)
    expect(written).toEqual(['one', 'onetwo'])
  })

  it('handles 100 MB of 64 KiB chunks well under the old 11.6 s cost', () => {
    const cap = 1024 * 1024
    const sink = new StreamSink('/dev/null', cap, persist)
    const chunk = 'y'.repeat(64 * 1024)
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 1600; i += 1) sink.push(chunk)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    console.log(`BENCH StreamSink 100 MB / 64 KiB chunks @ 1 MiB cap: ${ms.toFixed(1)} ms`)
    expect(Buffer.byteLength(sink.content(), 'utf8')).toBeLessThanOrEqual(cap)
    expect(ms).toBeLessThan(3000)
  })

  it('leaves tailByBytes intact for the delegate service', () => {
    // Unchanged pre-existing behaviour, quirk included: the binary search keeps
    // the longest suffix whose byte length is STRICTLY below `bytes`, so a
    // 3-byte ask over ASCII yields 2 chars. This PR does not touch it.
    expect(tailByBytes('abcdef', 3)).toBe('ef')
    expect(tailByBytes('abcdef', 100)).toBe('abcdef')
    expect(tailByBytes('abcdef', 0)).toBe('')
  })
})
