/**
 * Three gaps in the decision indexer, all on the read side of `indexLogLines`.
 *
 * 1. MARKER TOLERANCE. `parseDecisionLine` strips `/^[\s>*_#-]+/` and documents
 *    that "leading list dash, quote, blockquote and emphasis markers are all
 *    noise". The indexer pre-filtered with `l.trim().startsWith('- [decision]')`
 *    instead, so only the literal dash form ever reached the parser: every other
 *    documented marker was unreachable and silently dropped.
 *
 * 2. DEDUP IDENTITY. `decisionKey` is (context, chosen) only. Two genuinely
 *    different decisions that share a context and a chosen option — different
 *    rationale, different day — collide, and the second is skipped as "already
 *    stored" with no error.
 *
 * 3. TRUNCATED READ. `logRead` cuts its text at `caps.searchResultChars` and
 *    appends a `[… truncated]` marker. The indexer split that text and treated
 *    every line as complete, so a decision beyond the cut was reported as a
 *    clean "found nothing" run — and a line caught mid-cut could be stored as a
 *    half record.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decisionService } from '../../src/host/modules/decisions/index.ts'
import type { DecisionService } from '../../src/host/modules/decisions/index.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import { isoDate } from '../../src/lib/ids.ts'
import { makeFakeContext } from '../rooms/helpers.ts'
import type { ModuleDeps } from '../../src/host/types.ts'

let root = ''
let store: CortexStore
let svc: DecisionService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-decindex-'))
  store = new CortexStore({ root })
  const cfg = resolveConfig({})
  const fake = makeFakeContext()
  const deps: ModuleDeps = {
    ctx: fake.ctx,
    cfg: () => cfg,
    store,
    log: () => {},
    warn: () => {},
    runtime: () => ({ modules: [], errors: [] }),
  }
  await store.init()
  svc = decisionService(deps)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

/** The indexer reads through `logRead`, so the line must live in today's file. */
async function writeLog(lines: string[]): Promise<void> {
  const file = store.paths.dailyLog(isoDate(new Date()))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
}

describe('decision indexer read-side gaps', () => {
  it('reads every marker the parser documents, not only the dash form', async () => {
    await writeLog([
      '- [decision] ctx dash | chosen: a | rationale: r1',
      '* [decision] ctx star | chosen: b | rationale: r2',
      '> [decision] ctx quote | chosen: c | rationale: r3',
      '  - [decision] ctx indent | chosen: d | rationale: r4',
    ])
    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30, linkMemories: false })
    console.log(`MARKERS indexed=${String(result.indexed)} errors=${JSON.stringify(result.errors)}`)
    expect(result.indexed).toBe(4)
  })

  it('does not drop a different decision that shares context and chosen', async () => {
    await writeLog(['- [decision] same ctx | chosen: same | rationale: first reason'])
    const first = await svc.indexLogLines({ scope: 'daily', lastDays: 30, linkMemories: false })
    expect(first.indexed).toBe(1)

    await writeLog(['- [decision] same ctx | chosen: same | rationale: second, entirely different reason'])
    const second = await svc.indexLogLines({ scope: 'daily', lastDays: 30, linkMemories: false })
    console.log(`DEDUP first=${String(first.indexed)} second=${String(second.indexed)} skipped=${String(second.skipped)}`)
    expect(second.indexed).toBe(1)
  })

  it('says so when the read was truncated instead of reporting a clean run', async () => {
    const filler = Array.from({ length: 400 }, (_, index) => `- filler line ${String(index)} ${'x'.repeat(30)}`)
    await writeLog([...filler, '- [decision] beyond the cut | chosen: z | rationale: unreachable'])
    const result = await svc.indexLogLines({ scope: 'daily', lastDays: 30, linkMemories: false })
    console.log(`TRUNCATED indexed=${String(result.indexed)} errors=${JSON.stringify(result.errors)}`)
    // The decision sat past the read cap. Silence is the defect: the run looks
    // clean while a decision line was never examined.
    expect(result.errors.length).toBeGreaterThan(0)
  })
})
