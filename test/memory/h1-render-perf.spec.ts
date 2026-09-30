import { describe, expect, it } from 'vitest'
import { assembleBlock } from '../../src/host/modules/memory/render.ts'
import type { AssembleInput } from '../../src/host/modules/memory/render.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import type { Entry, Track } from '../../src/host/types.ts'

/**
 * H1 budget gate: 1500 entries through the renderer must stay under 30 ms.
 *
 * The renderer runs on EVERY turn of EVERY session, so this is the cost of the
 * turn, not of a test. 1500 entries with default caps is the worst case the
 * store can hand over: every per-track budget is exceeded and the total ceiling
 * has to trim ~1400 lines. Measured on this machine with `BENCH` printed, so a
 * regression shows as both a failed assert and a number.
 */

const BENCH_MS = 30

function makeEntries(count: number, track: Track): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: (index + 1).toString(16).padStart(12, '0').slice(-12),
    track,
    content: `entry ${String(index)} — a realistic memory line with words, a comma, a path /src/host/module.ts and a couple of tags. ${'padding '.repeat(14)}`,
    importance: 1 + (index % 5),
    tags: index % 3 === 0 ? ['perf', 'sprint2'] : [],
    createdAt: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: '2026-09-01T00:00:00.000Z',
    origin: index % 4 === 0 ? 'ai-confirmed' : 'user',
  }))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function runTimed(input: AssembleInput, rounds = 7): { median: number; best: number; result: AssembleResult } {
  const samples: number[] = []
  let result: AssembleResult | undefined
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now()
    result = assembleBlock(input)
    const elapsed = performance.now() - started
    if (round > 0) samples.push(elapsed)
  }
  return { median: median(samples), best: Math.min(...samples), result: result as AssembleResult }
}

describe('H1: assembleBlock perf gate', () => {
  it(`renders 1500 entries in under ${BENCH_MS} ms`, () => {
    const input: AssembleInput = {
      config: { injectLabel: '## Mnemon Runtime Memory Snapshot', caps: DEFAULT_CAPS },
      tracks: {
        user: makeEntries(500, 'user'),
        global: makeEntries(500, 'global'),
        project: makeEntries(500, 'project'),
        truncated: true,
        branch: 'perf/sprint2-h1-h3',
        pid: 'pid-1234-rest-of-the-id',
      },
      listCap: 500,
    }
    const { median: ms, best, result } = runTimed(input)
    console.log(`BENCH assembleBlock 1500 entries: median ${ms.toFixed(1)} ms, best ${best.toFixed(1)} ms, ${String(result.bytes)} bytes, omitted ${String(result.omitted)}`)
    // The gate also proves the work really happened: the ceiling trimmed.
    expect(result.omitted).toBeGreaterThan(1000)
    expect(result.block.length).toBeLessThanOrEqual(DEFAULT_CAPS.totalInjectChars)
    expect(ms).toBeLessThan(BENCH_MS)
  })

  it('renders 1500 entries that all FIT in under the gate too', () => {
    const input: AssembleInput = {
      config: { injectLabel: 'label', caps: { ...DEFAULT_CAPS, userTrackChars: 4_000_000, globalTrackChars: 4_000_000, projectTrackChars: 4_000_000, totalInjectChars: 4_000_000 } },
      tracks: {
        user: makeEntries(750, 'user'),
        global: makeEntries(750, 'global'),
        project: [],
        truncated: false,
        branch: null,
      },
    }
    const { median: ms, result } = runTimed(input)
    console.log(`BENCH assembleBlock 1500 entries (no trimming): median ${ms.toFixed(1)} ms, included ${String(result.included)}`)
    expect(result.omitted).toBe(0)
    expect(ms).toBeLessThan(BENCH_MS)
  })
})

type AssembleResult = ReturnType<typeof assembleBlock>
