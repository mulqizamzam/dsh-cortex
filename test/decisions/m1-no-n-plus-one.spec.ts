import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, decisionService } from '../../src/host/modules/decisions/index.ts'
import type { DecisionService } from '../../src/host/modules/decisions/index.ts'
import { searchEntries } from '../../src/host/modules/memory/search.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import { makeFakeContext } from '../rooms/helpers.ts'
import type { ModuleDeps } from '../../src/host/types.ts'

/**
 * M1: indexing a batch of decisions listed the WHOLE memory store once per
 * decision — `findRelatedEntries` re-read the user + global (+ project) entry
 * directories for every single line, so N decisions cost N listings. The entry
 * set cannot change while the loop runs (it writes decisions, not entries), so
 * one listing answers for all of them.
 *
 * RED evidence for the pre-fix shape is the call count (2 per decision), and
 * the VALUE contract is pinned by recomputing every decision's links here with
 * the old per-decision algorithm and comparing ids.
 */

const ENTRIES = 200
const DECISIONS = 40

let root: string
let store: CortexStore
let svc: DecisionService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-m1-'))
  store = new CortexStore({ root })
  const cfg = resolveConfig({})
  const fake = makeFakeContext()
  const deps: ModuleDeps = {
    ctx: fake.ctx,
    cfg: () => cfg,
    store,
    log: (message) => { fake.logs.push(message) },
    warn: (message) => { fake.warnings.push(message) },
    runtime: () => ({ modules: [], errors: [] }),
  }
  await store.init()
  svc = decisionService(deps)
  apply(deps)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

/** Entries whose text overlaps the decision lines below, so links are non-empty. */
async function seedEntries(): Promise<void> {
  for (let index = 0; index < ENTRIES; index += 1) {
    const track = index % 2 === 0 ? 'user' : 'global'
    const added = await store.addEntry({
      scope: { track },
      content: `decision topic ${index % 7}: the team chose option ${index % 5} for surface ${index % 3} because of reason ${index % 11}`,
      origin: 'user',
    })
    expect(added.ok).toBe(true)
  }
}

async function seedDecisionLines(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const lines: string[] = []
  for (let index = 0; index < DECISIONS; index += 1) {
    lines.push(`- [decision] Topic ${index % 7} step ${index} | options: option ${index % 5}, other | chosen: option ${index % 5} | rationale: reason ${index % 11}`)
  }
  await mkdir(join(root, 'daily'), { recursive: true })
  await writeFile(join(root, 'daily', `${day}.md`), lines.join('\n'), 'utf8')
}

describe('M1: indexing decisions reads the memory store once', () => {
  it('lists entries once per run, not once per decision, and links the same ids', async () => {
    await seedEntries()
    await seedDecisionLines()

    const original = store.listEntries.bind(store)
    let calls = 0
    ;(store as unknown as { listEntries: typeof store.listEntries }).listEntries = filter => {
      calls += 1
      return original(filter)
    }

    const started = performance.now()
    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    const ms = performance.now() - started
    console.log(`BENCH indexLogLines ${DECISIONS} decisions x ${ENTRIES} entries: ${ms.toFixed(1)} ms, listEntries calls ${String(calls)}`)

    expect(result.indexed).toBe(DECISIONS)
    expect(result.errors).toEqual([])
    // user + global, once each — not once per decision.
    expect(calls, 'the entry listing must be hoisted out of the per-decision loop').toBe(2)

    // VALUE equivalence: recompute every link with the pre-fix algorithm.
    const scopes = [{ track: 'user' as const }, { track: 'global' as const }]
    const pool = []
    for (const scope of scopes) {
      const listed = await original({ track: scope.track, branch: null })
      if (listed.ok) pool.push(...listed.data.entries)
    }
    const stored = await svc.list({ limit: 100 })
    expect(stored.decisions).toHaveLength(DECISIONS)
    for (const decision of stored.decisions) {
      const query = `${decision.context} ${decision.chosen}`.trim()
      const expected = query === '' || pool.length === 0
        ? []
        : searchEntries({ entries: pool, query, limit: 5 }).hits.map(hit => hit.id).slice(0, 5)
      expect(new Set(decision.linkedEntries), `links for ${decision.id}`).toEqual(new Set(expected))
    }
    expect(result.linked).toBeGreaterThan(0)
  })

  it('still links nothing, and still lists once, when the store has no entries', async () => {
    await seedDecisionLines()
    const original = store.listEntries.bind(store)
    let calls = 0
    ;(store as unknown as { listEntries: typeof store.listEntries }).listEntries = filter => {
      calls += 1
      return original(filter)
    }
    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    expect(result.indexed).toBe(DECISIONS)
    expect(result.linked).toBe(0)
    expect(calls).toBe(2)
  })

  it('linkMemories false lists nothing at all', async () => {
    await seedEntries()
    await seedDecisionLines()
    const original = store.listEntries.bind(store)
    let calls = 0
    ;(store as unknown as { listEntries: typeof store.listEntries }).listEntries = filter => {
      calls += 1
      return original(filter)
    }
    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30, linkMemories: false })
    expect(result.indexed).toBe(DECISIONS)
    expect(result.linked).toBe(0)
    expect(calls, 'a run that links nothing must not list entries').toBe(0)
  })
})
