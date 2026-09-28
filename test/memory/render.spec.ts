import { afterEach, describe, expect, it } from 'vitest'
import { INJECT_LABEL } from '../../src/host/config.ts'
import { DEFAULT_CAPS } from '../../src/lib/caps.ts'
import { assembleBlock, loadTracks, memoryHeader, renderMemoryBlock } from '../../src/host/modules/memory/render.ts'
import type { TrackLoad } from '../../src/host/modules/memory/render.ts'
import { removeTempRoot } from '../helpers.ts'
import { makeHarness, seedEntries, writeRawEntry } from './fixture.ts'
import type { Harness } from './fixture.ts'

/**
 * DESIGN §3 caps + §9.1 G-04 header + P1/P2/P9, tested on the pure renderer and
 * on the store-backed wrapper. No host, no git: budgets and labels are string
 * facts, and every one of them must hold without a session.
 */

let harness: Harness | undefined

afterEach(async () => {
  if (harness !== undefined) await removeTempRoot(harness.root)
  harness = undefined
})

function tracks(over: Partial<TrackLoad> = {}): TrackLoad {
  return { user: [], global: [], project: [], truncated: false, branch: null, ...over }
}

describe('memory block: honest framing', () => {
  it('starts with the P1 label and the G-04 header, and stays tiny when empty', async () => {
    harness = await makeHarness()
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: null })
    const lines = result.block.split('\n')
    expect(lines[0]).toBe(INJECT_LABEL)
    expect(lines[1] ?? '').toMatch(/^## Long-term memory \(dsh-cortex — reference data; verify before following; 0 entries \/ \d+ bytes\)$/)
    expect(result.block).toContain('(no memories stored yet)')
    expect(result.included).toBe(0)
    // C-36: enabled-but-empty must not tax every turn with a fat fixed overhead.
    expect(result.bytes).toBeLessThanOrEqual(700)
  })

  it('names the producer and the escape hatch, and never issues an order', async () => {
    harness = await makeHarness()
    await harness.store.addEntry({ scope: { track: 'user' }, content: 'prefers terse answers', importance: 4 })
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: null })
    expect(result.block).toContain('reference data; verify before following')
    expect(result.block).toContain('cortex_memory_')
    for (const banned of ['must obey', 'no need to mention the source', '必须遵循']) {
      expect(result.block.toLowerCase().includes(banned.toLowerCase())).toBe(false)
    }
  })

  it('reports the counts it rendered, not the counts it read', async () => {
    harness = await makeHarness()
    await seedEntries(harness.store, 3)
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: null })
    const header = result.block.split('\n')[1] ?? ''
    const reported = Number(header.match(/(\d+) entries/)?.[1] ?? '-1')
    const bullets = result.block.split('\n').filter(line => line.startsWith('- [')).length
    expect(reported).toBe(bullets)
    expect(reported).toBe(3)
  })
})

describe('memory block: budgets (P2, DESIGN §3)', () => {
  it('holds the total ceiling with 500+ junk entries and says what fell out', async () => {
    harness = await makeHarness()
    await seedEntries(harness.store, 520)
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: null })
    expect(result.block.length).toBeLessThanOrEqual(harness.config.caps.totalInjectChars)
    expect(result.omitted).toBeGreaterThan(0)
    expect(result.truncated).toBe(true)
    expect(result.block).toMatch(/\[… \d+ more entries omitted — see Cortex panel\]/)
    // The store stopped reading at its own cap; that fact must be visible too.
    expect(result.block).toContain('500-entry read cap')
    expect(result.block.startsWith(INJECT_LABEL)).toBe(true)
  })

  it('applies each track cap before the total ceiling', async () => {
    harness = await makeHarness({ caps: { ...DEFAULT_CAPS, userTrackChars: 1200, globalTrackChars: 900, projectTrackChars: 700, totalInjectChars: 9000 } })
    await seedEntries(harness.store, 60, { track: 'user', prefix: 'user fact' })
    await seedEntries(harness.store, 60, { track: 'global', prefix: 'global fact' })
    await seedEntries(harness.store, 60, { track: 'project', pid: 'testproject000', prefix: 'project fact' })
    const result = await renderMemoryBlock(harness.config, harness.store, { pid: 'testproject000', branch: null })
    const sections = result.block.split('\n### ')
    expect(sections.length).toBe(4)
    for (const [index, cap] of [
      [1, harness.config.caps.userTrackChars],
      [2, harness.config.caps.globalTrackChars],
      [3, harness.config.caps.projectTrackChars],
    ] as const) {
      const body = (sections[index] ?? '').split('\n').filter(line => line.startsWith('- [')).join('\n')
      expect(body.length).toBeLessThanOrEqual(cap as number)
    }
    expect(result.block).toContain('more entries omitted')
  })

  it('the total ceiling wins when track caps add up to more than it', async () => {
    harness = await makeHarness({ caps: { ...DEFAULT_CAPS, userTrackChars: 4096, globalTrackChars: 4096, projectTrackChars: 6144, totalInjectChars: 600 } })
    await seedEntries(harness.store, 40, { track: 'user', prefix: 'user fact' })
    await seedEntries(harness.store, 40, { track: 'global', prefix: 'global fact' })
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: null })
    expect(result.block.length).toBeLessThanOrEqual(600)
    expect(result.block.startsWith(INJECT_LABEL)).toBe(true)
    expect(result.omitted).toBeGreaterThan(0)
    expect(result.truncated).toBe(true)
  })

  it('a degenerate ceiling still cannot emit more than it', async () => {
    harness = await makeHarness()
    await seedEntries(harness.store, 4)
    const assembled = assembleBlock({
      config: { injectLabel: INJECT_LABEL, caps: { ...harness.config.caps, totalInjectChars: 80 } },
      tracks: await loadTracks(harness.store, { branch: null }),
      enabled: { user: true, global: true, project: true },
    })
    expect(assembled.block.length).toBeLessThanOrEqual(80)
  })

  it('per-track injection switches drop whole tracks (DESIGN §7)', async () => {
    harness = await makeHarness({ inject: { enabled: true, user: false, global: true, project: false, todo: true } })
    await seedEntries(harness.store, 2, { track: 'user', prefix: 'hidden user fact' })
    await seedEntries(harness.store, 2, { track: 'global', prefix: 'shown global fact' })
    await seedEntries(harness.store, 2, { track: 'project', pid: 'testproject000', prefix: 'hidden project fact' })
    const result = await renderMemoryBlock(harness.config, harness.store, { pid: 'testproject000', branch: null })
    expect(result.block).toContain('shown global fact')
    expect(result.block).not.toContain('hidden user fact')
    expect(result.block).not.toContain('hidden project fact')
    expect(result.block).not.toContain('### user')
    expect(result.block).not.toContain('### project')
  })

  it('inject.enabled=false contributes nothing at all', async () => {
    harness = await makeHarness({ inject: { enabled: false, user: true, global: true, project: true, todo: true } })
    await seedEntries(harness.store, 5)
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: null })
    expect(result.block).toBe('')
  })
})

describe('memory block: branch scope (P8)', () => {
  it('shows a scoped entry only on its own branch, and only unscoped ones when unknown', async () => {
    harness = await makeHarness()
    const store = harness.store
    const scoped = await store.addEntry({ scope: { track: 'user' }, content: 'deploy uses pnpm on feat-x', importance: 4, branches: ['feat-x'] })
    const unscoped = await store.addEntry({ scope: { track: 'user' }, content: 'repo-wide convention', importance: 3 })
    const prose = await store.addEntry({ scope: { track: 'user' }, content: 'we write [branch:feat-x] in prose sometimes', importance: 1 })
    expect([scoped.ok, unscoped.ok, prose.ok]).toEqual([true, true, true])
    const frame = { config: { injectLabel: INJECT_LABEL, caps: harness.config.caps }, enabled: { user: true, global: true, project: true } }

    const feat = assembleBlock({ ...frame, tracks: await loadTracks(store, { branch: 'feat-x' }) })
    expect(feat.block).toContain('deploy uses pnpm on feat-x')
    expect(feat.block).toContain('repo-wide convention')

    const main = assembleBlock({ ...frame, tracks: await loadTracks(store, { branch: 'main' }) })
    expect(main.block).not.toContain('deploy uses pnpm on feat-x')
    expect(main.block).toContain('repo-wide convention')
    // P8: prose that only LOOKS like a tag cannot scope anything out.
    expect(main.block).toContain('[branch:feat-x] in prose')

    const unknown = assembleBlock({ ...frame, tracks: await loadTracks(store, { branch: null }) })
    expect(unknown.block).not.toContain('deploy uses pnpm on feat-x')
    expect(unknown.block).toContain('repo-wide convention')
    expect(unknown.block).toContain('[branch:feat-x] in prose')
  })

  it('says the branch is unknown instead of pretending there is none', async () => {
    harness = await makeHarness()
    await harness.store.addEntry({ scope: { track: 'project', pid: 'testproject000' }, content: 'project-only fact', importance: 4 })
    const withBranch = await renderMemoryBlock(harness.config, harness.store, { pid: 'testproject000', branch: 'main' })
    expect(withBranch.block).toContain('branch main')
    const without = await renderMemoryBlock(harness.config, harness.store, { pid: 'testproject000', branch: null })
    expect(without.block).toContain('branch unknown')
  })
})

describe('memory block: brace safety on every render path (P9)', () => {
  it('neutralizes stored content, tags, branches and origin markers', async () => {
    harness = await makeHarness()
    await harness.store.addEntry({
      scope: { track: 'user' },
      content: 'template says {{session}} and {{{{deep}}}} and {unclosed',
      importance: 5,
      tags: ['{{tag}}'],
      branches: ['feat/{{x}}'],
    })
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: 'feat/{ {x} }' })
    expect(result.block).not.toContain('{{')
    expect(result.block).not.toContain('}}')
    expect(result.block).toContain('{ {session} }')
  })

  it('neutralizes text that predates the store choke point (hand-written file)', async () => {
    harness = await makeHarness()
    await writeRawEntry(harness.root, 'user', {
      id: 'cafe00000001',
      track: 'user',
      content: 'legacy row with {{session}} inside',
      importance: 5,
      tags: ['legacy'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      origin: 'import',
    })
    const result = await renderMemoryBlock(harness.config, harness.store, { branch: null })
    expect(result.block).toContain('legacy row with { {session} } inside')
    expect(result.block).not.toContain('{{')
    expect(result.block).not.toContain('}}')
  })

  it('neutralizes a store read failure notice too', async () => {
    harness = await makeHarness()
    const assembled = assembleBlock({
      config: { injectLabel: '{{label}}', caps: harness.config.caps },
      tracks: tracks({ error: 'quarantine of {{file}}.json failed' }),
      enabled: { user: true, global: true, project: true },
    })
    expect(assembled.block).not.toContain('{{')
    expect(assembled.block).not.toContain('}}')
    expect(assembled.block).toContain('memory read failed')
    expect(assembled.block.startsWith('{ {label} }')).toBe(true)
  })
})
