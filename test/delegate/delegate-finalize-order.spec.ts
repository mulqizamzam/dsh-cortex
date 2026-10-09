/**
 * Regression test for race (a): finalize must not expose a terminal job.json
 * while result.md is still a partial disposition.
 *
 * Invariant under test: when the terminal patch (status = succeeded |
 * dead-letter | failed | timeout) lands in job.json, the result.md on disk
 * MUST already contain the same disposition in its header and the write-back
 * section (for succeeded jobs). Deterministic barrier — no sleeps, no timing
 * windows, no sleeps. The patch is the only observable event for job.json;
 * result.md is read from disk after the patch returns.
 *
 * Separately from the M5c correctness tests (m5c-races.spec.ts), which test
 * the same invariant for a FAILED / dead-letter job via event-intercept, this
 * file tests the SUCCEEDED path end-to-end so the real store + writeBack
 * plumbing is exercised (logAppend, addPending, postMessage all run).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import { DelegateService } from '../../src/host/modules/delegate/service.ts'
import { RESULT_HEADER } from '../../src/host/modules/delegate/types.ts'
import { isRetryable } from '../../src/host/modules/delegate/types.ts'

let root = ''

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

function makeService(): DelegateService {
  const cfg = resolveConfig({ ...DEFAULT_CONFIG, delegation: { ...DEFAULT_CONFIG.delegation, enabled: true } })
  const store = new CortexStore({ root: root as string, caps: () => cfg.caps })
  void store.init()
  const deps = {
    ctx: { tools: { register: () => () => {} }, agents: { get: () => undefined, roots: () => [] }, on: () => () => {}, effect: (fn: () => unknown) => fn() },
    cfg: () => cfg,
    store,
    log: () => {},
    warn: () => {},
    runtime: () => ({ modules: [], errors: [] }),
  } as never
  return new DelegateService(deps)
}

function fileText(path: string): Promise<string> {
  return import('node:fs/promises').then(fs => fs.readFile(path, 'utf8').catch(() => ''))
}

describe('Race (a) — succeeded path: terminal patch is NOT observable before result.md is complete', () => {
  it('writes the complete result.md (including write-back) before the terminal status patch', async () => {
    root = await mkdtemp(join(tmpdir(), 'finalize-a-succeeded-'))
    const svc = makeService()
    const store = (svc as unknown as { deps: { store: CortexStore } }).deps.store
    await store.init()

    const created = await store.createJob({ runner: 'echo', argv: ['/bin/echo', 'ok'], task: 'race-a succeeded' })
    if (created.data === undefined) throw new Error('no job')
    const job = { ...created.data, status: 'succeeded' as const }
    const files = store.jobPaths(job.id)

    // Two files, two events — a concurrent reader can observe either or both.
    const events: Array<{ kind: 'result-md' | 'patch'; at: number }> = []
    let tick = 0
    const realUpdateJob = store.updateJob.bind(store)
    const realWriteStateFile = store.writeStateFile.bind(store)
    ;(store as unknown as { updateJob: typeof store.updateJob }).updateJob = async (id, patch) => {
      if ((patch as { status?: string }).status !== undefined) events.push({ kind: 'patch', at: tick++ })
      return realUpdateJob(id, patch)
    }
    ;(store as unknown as { writeStateFile: typeof store.writeStateFile }).writeStateFile = async (file, _text) => {
      if (String(file).endsWith('result.md')) events.push({ kind: 'result-md', at: tick++ })
      return realWriteStateFile(file, _text)
    }

    await svc.finalize(job, { status: 'succeeded', exitCode: 0 })

    // The terminal patch must be the LAST write event for this job.
    const lastEvent = events[events.length - 1]
    expect(lastEvent?.kind, 'the last write event must be the terminal patch').toBe('patch')
    // There must be at least one result.md write before it.
    const resultEvents = events.filter(e => e.kind === 'result-md')
    expect(resultEvents.length, 'result.md must be written at least once').toBeGreaterThanOrEqual(1)
    expect(resultEvents[resultEvents.length - 1].at, 'the final result.md write must precede the terminal patch').toBeLessThan(lastEvent.at)

    // And the FINAL result.md on disk must be complete: header + write-back
    // section present, not just a partial disposition.
    const final = await fileText(files.result)
    expect(final, 'result.md header must name the terminal status').toContain(`# Delegate job ${job.id} — succeeded`)
    expect(final, 'result.md must contain the write-back section after a succeeded job').toContain('## write-back')
  })
})

describe('Race (a) — dead-letter path: terminal patch is NOT observable before result.md is complete', () => {
  it('records the order: result.md disposition lands before the terminal patch, and both agree', async () => {
    root = await mkdtemp(join(tmpdir(), 'finalize-a-deadletter-'))
    const svc = makeService()
    const store = (svc as unknown as { deps: { store: CortexStore } }).deps.store
    await store.init()

    // A job that will dead-letter: exhausted retries, terminal status =
    // dead-letter (not the raw run outcome 'failed'). The artifact must
    // agree with that status, and the status must not be observable before
    // the artifact carries it.
    const created = await store.createJob({ runner: 'failAlways', argv: ['/bin/false'], task: 'race-a dead-letter' })
    if (created.data === undefined) throw new Error('no job')
    const job = { ...created.data, retryCount: 2, maxRetries: 2 } as unknown as import('../../src/host/modules/delegate/types.ts').DelegateJob
    const files = store.jobPaths(job.id)

    const events: Array<{ kind: 'result-md' | 'patch'; at: number }> = []
    let tick = 0
    const realUpdateJob = store.updateJob.bind(store)
    const realWriteStateFile = store.writeStateFile.bind(store)
    ;(store as unknown as { updateJob: typeof store.updateJob }).updateJob = async (id, patch) => {
      if ((patch as { status?: string }).status !== undefined) events.push({ kind: 'patch', at: tick++ })
      return realUpdateJob(id, patch)
    }
    ;(store as unknown as { writeStateFile: typeof store.writeStateFile }).writeStateFile = async (file, _text) => {
      if (String(file).endsWith('result.md')) events.push({ kind: 'result-md', at: tick++ })
      return realWriteStateFile(file, _text)
    }

    await svc.finalize(job, { status: 'failed', exitCode: 1 })

    const patchIndex = events.findIndex(e => e.kind === 'patch')
    const resultIndex = events.findIndex(e => e.kind === 'result-md')
    expect(patchIndex, 'the terminal patch must happen').toBeGreaterThanOrEqual(0)
    expect(resultIndex, 'result.md must be written at all').toBeGreaterThanOrEqual(0)
    expect(resultIndex, 'result.md must land before the terminal patch').toBeLessThan(patchIndex)

    const final = await fileText(files.result)
    expect(final, 'result.md header must name the terminal status (dead-letter)').toContain(`# Delegate job ${job.id} — dead-letter`)
    expect(final, 'result.md must NOT still say the raw outcome').not.toMatch(/# Delegate job \S+ — failed/)
    expect(final, 'dead-letter notes must be present').toContain('## dead-letter')
    expect(final, 'attempt line must reflect the exhausted retry budget').toMatch(/attempt: 3 of 3 \(auto-retries: 2\/2\)/)
  })
})
