import { describe, expect, it } from 'vitest'
import { assembleBlock, fitLines } from '../../src/host/modules/memory/render.ts'
import type { AssembleInput, TrackLoad } from '../../src/host/modules/memory/render.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { legacyAssembleBlock, legacyFitLines } from './legacy-render.ts'
import type { Entry, Track } from '../../src/host/types.ts'

/**
 * H1: the fast renderer must be the SAME renderer.
 *
 * `fitLines` lost its re-join-per-candidate loop and `assembleBlock` stopped
 * rebuilding the whole block once per dropped line. Both keep their exact
 * outputs: this file compares them against the frozen pre-H1 copy in
 * `legacy-render.ts` over randomised inputs — track mixes, multibyte content,
 * zero and tiny budgets, tight ceilings, notices, branch scoping.
 *
 * A perf change that quietly moves a boundary would be a correctness bug, and
 * the cheapest way to prove it did not is to keep the old code and diff both.
 */

/** Deterministic PRNG, so a failure is reproducible from the seed alone. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ORIGINS: Entry['origin'][] = ['user', 'ai-confirmed', 'import']
const ALPHABETS = ['abcdefghij ', 'ünïcödé 😀 ', 'a', 'x'.repeat(120)]

function makeEntry(random: () => number, index: number, track: Track): Entry {
  const alphabet = ALPHABETS[Math.floor(random() * ALPHABETS.length)] ?? 'plain '
  const length = 1 + Math.floor(random() * 180)
  let content = ''
  for (let i = 0; i < length; i += 1) content += alphabet[Math.floor(random() * alphabet.length)] ?? 'x'
  const tags = random() < 0.3 ? ['one', 'two'] : []
  const branches = random() < 0.25 ? ['feat/x'] : undefined
  return {
    id: (index + 1).toString(16).padStart(12, '0').slice(-12),
    track,
    content,
    importance: 1 + Math.floor(random() * 5),
    tags,
    createdAt: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: '2026-09-01T00:00:00.000Z',
    origin: ORIGINS[Math.floor(random() * ORIGINS.length)] ?? 'user',
    ...(branches === undefined ? {} : { branches }),
    ...(track === 'project' ? { pid: 'pid-1234-rest' } : {}),
  }
}

function makeCase(seed: number): AssembleInput {
  const random = prng(seed)
  const count = (track: Track): number => Math.floor(random() * 12)
  const withPid = random() < 0.7
  const branch = random() < 0.4 ? null : (random() < 0.5 ? 'feat/x' : 'main')
  const tracks: TrackLoad = {
    user: Array.from({ length: count('user') }, (_, i) => makeEntry(random, i, 'user')),
    global: Array.from({ length: count('global') }, (_, i) => makeEntry(random, i + 50, 'global')),
    project: Array.from({ length: count('project') }, (_, i) => makeEntry(random, i + 100, 'project')),
    truncated: random() < 0.2,
    branch,
    ...(withPid ? { pid: 'pid-1234-rest-of-the-id' } : {}),
  }
  const tight = random() < 0.35
  return {
    config: {
      injectLabel: '## Mnemon Runtime Memory Snapshot',
      caps: {
        ...DEFAULT_CAPS,
        userTrackChars: tight ? Math.floor(random() * 400) : DEFAULT_CAPS.userTrackChars,
        globalTrackChars: tight ? Math.floor(random() * 400) : DEFAULT_CAPS.globalTrackChars,
        projectTrackChars: tight ? Math.floor(random() * 600) : DEFAULT_CAPS.projectTrackChars,
        totalInjectChars: random() < 0.5 ? Math.floor(random() * 3000) : DEFAULT_CAPS.totalInjectChars,
      },
    },
    tracks,
    ...(random() < 0.3 ? { enabled: { user: false, global: true, project: true } } : {}),
    ...(random() < 0.3 ? { listCap: 500 } : {}),
    ...(random() < 0.15 ? { tracks: { ...tracks, error: 'EACCES on one track' } } : {}),
  }
}

describe('H1: fitLines keeps the exact same fit boundary', () => {
  it('matches the pre-H1 fit on randomised line sets and budgets', () => {
    const random = prng(0xC0FFEE)
    for (let caseIndex = 0; caseIndex < 400; caseIndex += 1) {
      const lines = Array.from({ length: Math.floor(random() * 25) }, () => {
        const length = Math.floor(random() * 90)
        return 'x'.repeat(length) + (random() < 0.2 ? '😀' : '')
      })
      const budget = Math.floor(random() * 400)
      const now = fitLines(lines, budget)
      const before = legacyFitLines(lines, budget)
      expect({ ...now, kept: now.kept }, `seed 0xC0FFEE case ${caseIndex} budget ${budget} lines ${lines.length}`).toEqual(before)
    }
  })

  it('keeps the documented edges: empty, zero budget, all fit, none fit', () => {
    expect(fitLines([], 100)).toEqual({ kept: [], omitted: 0 })
    expect(fitLines(['a', 'b'], 0)).toEqual({ kept: [], omitted: 2 })
    expect(fitLines(['a', 'b'], -5)).toEqual({ kept: [], omitted: 2 })
    expect(fitLines(['a', 'bb'], 10)).toEqual({ kept: ['a', 'bb'], omitted: 0 })
    const none = fitLines(['aaaa', 'bbbb'], 4)
    expect(none.omitted).toBe(2)
    expect(none.kept).toEqual([])
  })

  it('never exceeds the budget and always keeps a prefix, at any size', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i}-${'y'.repeat(i % 17)}`)
    for (const budget of [0, 1, 5, 50, 500, 2000, 9000]) {
      const result = fitLines(lines, budget)
      expect(result.kept).toEqual(lines.slice(0, result.kept.length))
      if (result.kept.length === 0) {
        // Not even one line plus the note fits: keep nothing. The omission note
        // is the disclosure, so it is allowed to exceed a budget too small for it.
        expect(result.omitted).toBe(lines.length)
        continue
      }
      const rendered = [...result.kept, ...(result.omitted > 0 ? [`[… ${result.omitted} more entries omitted — see Cortex panel]`] : [])].join('\n')
      expect(rendered.length, `budget ${budget}`).toBeLessThanOrEqual(budget)
    }
  })
})

describe('H1: assembleBlock is byte-identical to the pre-H1 renderer', () => {
  it('matches on 400 randomised cases (block, counts, flags and byte size)', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const input = makeCase(seed)
      const now = assembleBlock(input)
      const before = legacyAssembleBlock(input)
      expect(now, `seed ${seed}`).toEqual(before)
    }
  })

  it('matches when the ceiling loop has to trim hard (the hot path)', () => {
    const random = prng(0x5EED)
    const entries = Array.from({ length: 400 }, (_, i) => makeEntry(random, i, 'user'))
    for (const ceiling of [40, 120, 400, 1200, 4000, 14000]) {
      const input: AssembleInput = {
        config: { injectLabel: 'label', caps: { ...DEFAULT_CAPS, userTrackChars: 14000, totalInjectChars: ceiling } },
        tracks: { user: entries, global: [], project: [], truncated: false, branch: null },
      }
      expect(assembleBlock(input), `ceiling ${ceiling}`).toEqual(legacyAssembleBlock(input))
    }
  })

  it('matches on an empty store and on a store that failed a track', () => {
    const empty: AssembleInput = {
      config: { injectLabel: 'label', caps: DEFAULT_CAPS },
      tracks: { user: [], global: [], project: [], truncated: false, branch: null },
    }
    expect(assembleBlock(empty)).toEqual(legacyAssembleBlock(empty))
    const failed: AssembleInput = { ...empty, tracks: { ...empty.tracks, error: 'EACCES', truncated: true }, listCap: 500 }
    expect(assembleBlock(failed)).toEqual(legacyAssembleBlock(failed))
  })
})
