/**
 * Decision tool integration tests.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOOLS, apply, decisionService, decisionListHeader } from '../../src/host/modules/decisions/index.ts'
import type { DecisionService } from '../../src/host/modules/decisions/index.ts'
import { makeFakeContext } from '../rooms/helpers.ts'
import { CortexStore } from '../../src/host/store.ts'
import { resolveConfig } from '../../src/host/config.ts'
import type { ModuleDeps } from '../../src/host/types.ts'

let root: string
let store: CortexStore
let deps: ModuleDeps
let svc: DecisionService

beforeEach(async () => {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  root = await fs.mkdtemp(join(os.tmpdir(), 'dsh-cortex-decisions-'))
  store = new CortexStore({ root })
  const cfg = resolveConfig({})
  const fake = makeFakeContext()
  deps = {
    ctx: fake.ctx,
    cfg: () => cfg,
    store,
    log: (m) => { fake.logs.push(m) },
    warn: (m) => { fake.warnings.push(m) },
    runtime: () => ({ modules: [], errors: [] }),
  }
  await store.init()
  svc = decisionService(deps)
  apply(deps)
})

afterEach(async () => {
  await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('cortex_decision_index_logs', () => {
  it('indexes decisions from a populated log file', async () => {
    // Write a daily log with a [decision] line (use current date so lastDays=30 covers it)
    const day = new Date().toISOString().slice(0, 10)
    const logDir = join(root, 'daily')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      join(logDir, `${day}.md`),
      `- some other line\n- [decision] Picked blue theme | options: blue, red | chosen: blue | rationale: matches brand`,
      'utf8'
    )

    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    expect(result.indexed).toBe(1)
    expect(result.errors).toEqual([])
  })

  it('returns zero when no decision lines exist', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const logDir = join(root, 'daily')
    await mkdir(logDir, { recursive: true })
    await writeFile(join(logDir, `${day}.md`), '- just a normal line\n- another line', 'utf8')

    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    expect(result.indexed).toBe(0)
  })

  it('re-index skips already-stored decisions (dedup)', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const logDir = join(root, 'daily')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      join(logDir, `${day}.md`),
      '- [decision] Choose color | options: blue, red | chosen: blue | rationale: brand',
      'utf8'
    )
    const first = await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    expect(first.indexed).toBe(1)

    const second = await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    expect(second.indexed).toBe(0)
    expect(second.skipped).toBe(1)
  })

  it('reindex=true forces fresh copies for every line', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const logDir = join(root, 'daily')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      join(logDir, `${day}.md`),
      '- [decision] Choose color | options: blue, red | chosen: blue | rationale: brand',
      'utf8'
    )
    await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    const fresh = await svc.indexLogLines({ scope: 'daily', lastDays: 30, reindex: true })
    expect(fresh.indexed).toBe(1)
    expect(fresh.skipped).toBe(0)
  })

  it('stamps owner from the caller session when passed', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const logDir = join(root, 'daily')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      join(logDir, `${day}.md`),
      '- [decision] Pick router | options: a, b | chosen: a | rationale: cheap',
      'utf8'
    )
    await svc.indexLogLines({ scope: 'daily', lastDays: 30, owner: 'sess-owner-1' })
    const found = await svc.search({ query: 'router' })
    expect(found.hits.length).toBeGreaterThanOrEqual(1)
    expect(found.hits[0].owner).toBe('sess-owner-1')
  })

  it('search hits carry a non-zero relevance score', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const logDir = join(root, 'daily')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      join(logDir, `${day}.md`),
      '- [decision] Adopt sqlite | options: sqlite, pg | chosen: sqlite | rationale: embedded testing',
      'utf8'
    )
    await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    const found = await svc.search({ query: 'sqlite' })
    expect(found.hits.length).toBeGreaterThanOrEqual(1)
    expect(found.hits[0].score).toBeGreaterThan(0)
  })
})

describe('cortex_decision_search', () => {
  it('finds decisions by query', async () => {
    const d1 = await store.addDecision({
      id: 'aaa111',
      decision: {
        id: 'aaa111', context: 'Picked database', options: ['postgres', 'sqlite'],
        chosen: 'postgres', rationale: 'better scalability', owner: 'user',
        timestamp: '2026-01-15T10:00:00Z', tags: ['db'], linkedEntries: [],
      },
    })
    expect(d1.ok).toBe(true)

    const d2 = await store.addDecision({
      id: 'bbb222',
      decision: {
        id: 'bbb222', context: 'Chose UI framework', options: ['react', 'vue'],
        chosen: 'react', rationale: 'ecosystem size', owner: 'user',
        timestamp: '2026-01-14T09:00:00Z', tags: ['ui'], linkedEntries: [],
      },
    })
    expect(d2.ok).toBe(true)

    const search = await svc.search({ query: 'database' })
    expect(search.hits.length).toBeGreaterThanOrEqual(1)
    expect(search.hits[0].id).toBe('aaa111')
  })

  it('search with tags filters correctly', async () => {
    const d1 = await store.addDecision({
      id: 'ccc333',
      decision: {
        id: 'ccc333', context: 'Picked database', options: ['pg'],
        chosen: 'pg', rationale: 'ok', owner: 'user',
        timestamp: '2026-01-15T10:00:00Z', tags: ['db', 'infra'], linkedEntries: [],
      },
    })
    expect(d1.ok).toBe(true)

    const result = await svc.search({ query: 'database', tags: ['db'] })
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.hits.some(h => h.id === 'ccc333')).toBe(true)

    const noMatch = await svc.search({ query: 'database', tags: ['nonexistent'] })
    expect(noMatch.hits.length).toBe(0)
  })

  it('returns all decisions when query is empty', async () => {
    await store.addDecision({
      id: 'ddd444',
      decision: {
        id: 'ddd444', context: 'Test', options: ['a'],
        chosen: 'a', rationale: 'x', owner: 'user',
        timestamp: '2026-01-10T10:00:00Z', tags: [], linkedEntries: [],
      },
    })
    const result = await svc.search({ query: '' })
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
  })
})

describe('module wiring', () => {
  it('exports exactly the four decision tools', () => {
    expect(TOOLS).toEqual([
      'cortex_decision_index_logs',
      'cortex_decision_search',
      'cortex_decision_list',
      'cortex_decision_link',
    ])
  })

  it('registers all four tools on apply', () => {
    const fake = makeFakeContext()
    const deps2: ModuleDeps = {
      ctx: fake.ctx,
      cfg: () => resolveConfig({}),
      store: new CortexStore({ root: join(root, 'wiring-test') }),
      log: () => {},
      warn: () => {},
      runtime: () => ({ modules: [], errors: [] }),
    }
    apply(deps2)
    expect(fake.tools.has('cortex_decision_index_logs')).toBe(true)
    expect(fake.tools.has('cortex_decision_search')).toBe(true)
    expect(fake.tools.has('cortex_decision_list')).toBe(true)
    expect(fake.tools.has('cortex_decision_link')).toBe(true)
  })
})

describe('linking decisions to memory', () => {
  /** Write today's daily log with one decision line. */
  async function writeDecisionLine(line: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10)
    const logDir = join(root, 'daily')
    await mkdir(logDir, { recursive: true })
    await writeFile(join(logDir, `${day}.md`), line, 'utf8')
  }

  it('auto-links an indexed decision to the memory entry it mentions', async () => {
    const entry = await store.addEntry({
      scope: { track: 'global' },
      content: 'The team decided to use postgres for the primary datastore because of scaling needs',
      origin: 'user',
    })
    expect(entry.ok).toBe(true)
    const entryId = (entry.data as { id: string }).id

    await writeDecisionLine('- [decision] Primary datastore | options: postgres, mysql | chosen: postgres | rationale: scaling needs')
    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30 })
    expect(result.indexed).toBe(1)
    expect(result.linked).toBeGreaterThanOrEqual(1)

    const listed = await svc.list({})
    const stored = listed.decisions[0]
    expect(stored?.linkedEntries).toContain(entryId)
  })

  it('linkMemories false stores the decision with no links', async () => {
    await store.addEntry({ scope: { track: 'global' }, content: 'postgres scaling decision', origin: 'user' })
    await writeDecisionLine('- [decision] Primary datastore | options: postgres, mysql | chosen: postgres | rationale: scaling')
    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30, linkMemories: false })
    expect(result.indexed).toBe(1)
    expect(result.linked).toBe(0)
    const listed = await svc.list({})
    expect(listed.decisions[0]?.linkedEntries).toEqual([])
  })

  it('cortex_decision_link merges ids into an existing decision', async () => {
    const a = await store.addEntry({ scope: { track: 'global' }, content: 'memory one', origin: 'user' })
    const b = await store.addEntry({ scope: { track: 'global' }, content: 'memory two', origin: 'user' })
    const aId = (a.data as { id: string }).id
    const bId = (b.data as { id: string }).id
    const stored = await store.addDecision({
      id: 'link001',
      decision: {
        id: 'link001', context: 'Linked decision', options: ['a'], chosen: 'a',
        rationale: 'r', owner: 'user', timestamp: '2026-02-01T00:00:00Z', tags: [], linkedEntries: [aId],
      },
    })
    expect(stored.ok).toBe(true)

    const result = await svc.link({ id: 'link001', entryIds: [bId, bId] })
    expect(result.ok).toBe(true)
    expect(result.decision?.linkedEntries).toEqual([aId, bId])
  })

  it('cortex_decision_link refuses an unknown decision id', async () => {
    const result = await svc.link({ id: 'nope001', entryIds: ['aaaaaaaaaaaa'] })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no stored decision')
  })

  it('cortex_decision_list renders a readable block with the linked memory ids', async () => {
    const entry = await store.addEntry({ scope: { track: 'global' }, content: 'rendered memory', origin: 'user' })
    const entryId = (entry.data as { id: string }).id
    await store.addDecision({
      id: 'list001',
      decision: {
        id: 'list001', context: 'Rendered decision', options: ['x', 'y'], chosen: 'x',
        rationale: 'because', owner: 'operator', timestamp: '2026-02-02T10:00:00Z',
        tags: ['demo'], linkedEntries: [entryId],
      },
    })
    const listed = await svc.list({})
    expect(listed.total).toBe(1)
    expect(listed.text).toContain('## Decision log')
    expect(listed.text).toContain('Rendered decision')
    expect(listed.text).toContain('chosen: x')
    expect(listed.text).toContain('owner: operator')
    expect(listed.text).toContain('links: 1 memory entry')
    expect(listed.text).toContain(entryId)
  })

  it('the list is honest when nothing is recorded', async () => {
    const listed = await svc.list({})
    expect(listed.total).toBe(0)
    expect(listed.text).toContain('nothing recorded')
  })

  it('the header separates its label from the counts', () => {
    // Regression found live: the counts ran into the label ("nothing summarised1 total").
    const header = decisionListHeader(3, 2)
    expect(header).toContain('nothing summarised; 3 total, 2 shown')
    expect(header).not.toMatch(/summarised\d/)
  })

  it('search reports linked memory ids on its hits', async () => {
    const entry = await store.addEntry({ scope: { track: 'global' }, content: 'searchable memory', origin: 'user' })
    const entryId = (entry.data as { id: string }).id
    await store.addDecision({
      id: 'srch001',
      decision: {
        id: 'srch001', context: 'Zebra migration', options: ['a'], chosen: 'a',
        rationale: 'why', owner: 'user', timestamp: '2026-02-03T00:00:00Z',
        tags: [], linkedEntries: [entryId],
      },
    })
    const found = await svc.search({ query: 'zebra' })
    expect(found.hits[0]?.linkedEntries).toEqual([entryId])
    expect(found.text).toContain('Zebra migration')
  })
})
