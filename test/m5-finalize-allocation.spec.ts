/**
 * M5 finalize audit — ALLOCATION/GC ONLY, no correctness changes here.
 *
 * Two race findings are deliberately NOT fixed in this file:
 *   (a) finalize patches job.json to the terminal status BEFORE it writes
 *       result.md, so a poller that sees the authoritative state can read a
 *       stale result.md (test/delegate/delegate.spec.ts "FINAL disposition",
 *       reproduced in .dev/flake/pair2-b.log);
 *   (b) `settle()` calls flushAll() but a flush already in flight has already
 *       cleared `dirty`, so flushAll() is a no-op and finalize may read a
 *       stdout file that is not complete yet (reproduced on PRE-M5 code,
 *       .dev/flake2/prec-28.log, test "echo fixture end to end").
 * Both are measured/characterized elsewhere and await a scope decision.
 *
 * What this file measures: how many bytes `finalize`'s body-composition step
 * allocates, how much of that survives a GC, and the wall time, on a
 * representative 1 MiB stdout. clampText is NOT modified.
 */
import { describe, expect, it } from 'vitest'
import { clampText, DEFAULT_CAPS } from '../src/lib/caps.ts'
import { neutralize } from '../src/lib/sanitize.ts'
import { summarize } from '../src/host/modules/delegate/service.ts'
import { tailByBytes } from '../src/host/modules/delegate/runner.ts'

const CAP = 1024 * 1024

/** A representative stdout body: build output, no `{{` (the common case). */
function body(overrides: { braces?: boolean } = {}): string {
  let out = ''
  let index = 0
  while (Buffer.byteLength(out, 'utf8') < CAP) {
    out += `line ${index}: built target/release in 1.2s, 4 warnings, ok\n`
    index += 1
  }
  out = Buffer.from(out, 'utf8').subarray(0, CAP).toString('utf8')
  return overrides.braces === true ? `${out}{{/x}}` : out
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

interface Measurement {
  ms: number
  allocated: number
  survivors: number
}

function measure(rounds: number, work: () => void): Measurement {
  global.gc?.()
  const before = process.memoryUsage()
  const started = performance.now()
  for (let round = 0; round < rounds; round += 1) work()
  const ms = (performance.now() - started) / rounds
  const after = process.memoryUsage()
  global.gc?.()
  const settled = process.memoryUsage()
  return {
    ms,
    allocated: Math.max(0, after.heapUsed - before.heapUsed),
    survivors: Math.max(0, settled.heapUsed - before.heapUsed),
  }
}

describe('M5 finalize allocation profile (body composition only)', () => {
  it('BENCH: each step of the current composition, on a 1 MiB body', () => {
    const clean = body()
    const braced = body({ braces: true })

    const steps: Array<{ name: string; run: () => void }> = [
      { name: 'tailByBytes(body, cap)', run: () => { void tailByBytes(clean, CAP) } },
      { name: 'neutralize(clean)  [no braces]', run: () => { void neutralize(clean) } },
      { name: 'neutralize(braced) [one {{ present]', run: () => { void neutralize(braced) } },
      { name: 'clampText(tail, searchResultChars)', run: () => { void clampText(clean, DEFAULT_CAPS.searchResultChars) } },
      { name: 'summarize(body)     [the split/map/filter]', run: () => { void summarize(clean) } },
    ]

    for (const step of steps) {
      const m = measure(5, step.run)
      console.log(
        `BENCH alloc ${step.name}: ${m.ms.toFixed(2)} ms, heap +${(m.allocated / 1024 / 1024).toFixed(1)} MiB during, ` +
        `+${(m.survivors / 1024 / 1024).toFixed(1)} MiB surviving GC`,
      )
    }
    // The current shape always pays for the split: ~17k strings for 1 MiB.
    const summaryResult = summarize(clean)
    expect(summaryResult.length).toBeLessThanOrEqual(240)
    expect(bytesOf(clean)).toBe(CAP)
  })

  it('BENCH: whole composition today vs a tail-first composition', () => {
    const clean = body()
    const searchChars = DEFAULT_CAPS.searchResultChars

    /** Exactly what finalize does today for the body (order preserved). */
    const today = (): void => {
      const tail = clampText(neutralize(tailByBytes(clean, CAP)), searchChars)
      void tail
      const summary = summarize(clean, undefined)
      void summary
    }

    /** Tail-first: slice to the budget before the whole-body helpers. */
    const tailFirst = (): void => {
      // 1) Keep only the bytes any consumer can use: the summary's first line
      //    and the clamped tail both come from the same bounded region.
      const head = Buffer.from(clean, 'utf8').subarray(0, 8192).toString('utf8')
      const summary = summarize(head, undefined)
      void summary
      const tail = clampText(neutralize(tailByBytes(clean, CAP)), searchChars)
      void tail
    }

    const a = measure(5, today)
    const b = measure(5, tailFirst)
    console.log(
      `BENCH alloc whole composition: today ${a.ms.toFixed(2)} ms / +${(a.allocated / 1024 / 1024).toFixed(1)} MiB, ` +
      `tail-first ${b.ms.toFixed(2)} ms / +${(b.allocated / 1024 / 1024).toFixed(1)} MiB`,
    )
    // Report only; the equivalence question is answered in the next test.
    expect(b.ms).toBeGreaterThan(0)
  })

  it('EQUIVALENCE: summarize only needs the first line, so a bounded head is enough', () => {
    const clean = body()
    // The first non-empty, non-omitted line is far inside the first 8 KiB.
    const head = Buffer.from(clean, 'utf8').subarray(0, 8192).toString('utf8')
    expect(summarize(head, undefined), 'summarize of a bounded head equals summarize of the whole body').toBe(summarize(clean, undefined))
  })

  it('BENCH GC pressure: legacy composition vs shipped, same run', async () => {
    const { PerformanceObserver } = await import('node:perf_hooks')
    const { clampText: cap, DEFAULT_CAPS: caps } = await import('../src/lib/caps.ts')
    const { neutralize: shippedNeutralize } = await import('../src/lib/sanitize.ts')
    const { summarize: shippedSummarize } = await import('../src/host/modules/delegate/service.ts')
    const { tailByBytes: tails } = await import('../src/host/modules/delegate/runner.ts')

    /** Pre-patch helpers, verbatim (as in m5-finalize-optim-equivalence). */
    const legacyNeutralize = (input: string): string => {
      if (typeof input !== 'string' || input === '') return ''
      if (!input.includes('{{') && !input.includes('}}')) return input
      let output = ''
      for (let index = 0; index < input.length; index += 1) {
        const ch = input[index] as string
        output += ch
        const next = input[index + 1]
        if ((ch === '{' || ch === '}') && next === ch) output += ' '
      }
      return output
    }
    const legacySummarize = (output: string, error?: string): string => {
      const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
      const first = lines.find(line => !line.startsWith('[…')) ?? lines[0]
      return cap(legacyNeutralize(first ?? error ?? '(no output)'), 240)
    }

    const braced = body({ braces: true })
    const measure = async (name: string, work: () => void, rounds: number): Promise<void> => {
      let events = 0
      let gcMs = 0
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          events += 1
          gcMs += entry.duration
        }
      })
      observer.observe({ entryTypes: ['gc'] })
      const started = performance.now()
      for (let round = 0; round < rounds; round += 1) work()
      const wall = performance.now() - started
      // GC entries are delivered asynchronously; flush before disconnecting or
      // the count silently reads zero (verified: plain node reports 28 events
      // for the same pattern when it is allowed to settle).
      await new Promise(resolve => setTimeout(resolve, 150))
      observer.disconnect()
      console.log(`BENCH GC ${name}: ${wall.toFixed(1)} ms wall, ${String(events)} GC events, ${gcMs.toFixed(1)} ms in GC`)
    }

    const rounds = 5
    await measure('legacy  (braced body: neutralize + summarize + clamp)', () => {
      void cap(legacyNeutralize(tails(braced, CAP)), caps.searchResultChars)
      void legacySummarize(braced, undefined)
    }, rounds)
    await measure('shipped (braced body: neutralize + summarize + clamp)', () => {
      void cap(shippedNeutralize(tails(braced, CAP)), caps.searchResultChars)
      void shippedSummarize(braced, undefined)
    }, rounds)
  })
})
