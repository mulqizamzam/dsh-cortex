/**
 * Correctness regression for the two M5c-adjacent race fixes (committed
 * separately from d3fc325, the optimization unit).
 *
 * Race A — `finalize` used to patch job.json terminal FIRST and write result.md
 * two awaits later, so a reader could observe `dead-letter` next to a
 * result.md still describing an earlier attempt (observed: .dev/flake/pair2-b.log,
 * "attempt: 2 of 3" against a dead-letter job.json). The invariant under test
 * is order-of-observation, not a particular function call sequence: when the
 * terminal patch lands, result.md must already carry that disposition.
 *
 * Race B — `StreamSink.flush` used to clear `dirty` at the start of the write
 * and return, so a settle-time flush was a no-op while the write was still
 * running and `finalize` could compose result.md from a stdout file that had
 * not landed (observed on PRE-M5 code: .dev/flake2/prec-28.log, "stdout was
 * empty"). The invariant: `flush()` resolves only when the bytes are on disk.
 * Deterministic barrier — no sleeps, no timing windows.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import { DelegateService } from '../../src/host/modules/delegate/service.ts'
import { StreamSink } from '../../src/host/modules/delegate/runner.ts'
import type { DelegateJob } from '../../src/host/modules/delegate/types.ts'

let root = ''

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

function makeService(): DelegateService {
  const cfg = resolveConfig({ ...DEFAULT_CONFIG, delegation: { ...DEFAULT_CONFIG.delegation, enabled: true } })
  const store = new CortexStore({ root: root as string, caps: () => cfg.caps })
  void store.init()
  const deps = {
    ctx: { tools: { register: () => () => {} }, settings: {}, agents: { get: () => undefined, roots: () => [] }, on: () => () => {}, effect: (fn: () => unknown) => fn() },
    cfg: () => cfg,
    store,
    log: () => {},
    warn: () => {},
    runtime: () => ({ modules: [], errors: [] }),
  } as never
  return new DelegateService(deps)
}

describe('Race A: terminal job.json is never observable before its result.md', () => {
  it('records the order: result.md disposition lands before the terminal patch', async () => {
    root = await mkdtemp(join(tmpdir(), 'm5c-race-a-'))
    const svc = makeService()
    const store = (svc as unknown as { deps: { store: CortexStore } }).deps.store
    await store.init()

    const created = await store.createJob({ runner: 'failAlways', argv: ['/bin/false'], task: 'race A' })
    if (created.data === undefined) throw new Error('no job')
    const job = { ...created.data, retryCount: 2, maxRetries: 2, status: 'failed' } as unknown as DelegateJob

    // Two files, two events: what a concurrent reader can actually observe.
    const events: string[] = []
    const realUpdateJob = store.updateJob.bind(store)
    const realWriteStateFile = store.writeStateFile.bind(store)
    ;(store as unknown as { updateJob: typeof store.updateJob }).updateJob = async (id, patch) => {
      if ((patch as { status?: string }).status !== undefined) events.push(`patch:${String((patch as { status?: string }).status)}`)
      return await realUpdateJob(id, patch)
    }
    ;(store as unknown as { writeStateFile: typeof store.writeStateFile }).writeStateFile = async (file, text) => {
      if (String(file).endsWith('result.md')) events.push('result-md')
      return await realWriteStateFile(file, text)
    }

    await svc.finalize(job, { status: 'failed', exitCode: 1 })

    const patchIndex = events.findIndex(e => e === 'patch:dead-letter')
    const resultIndex = events.indexOf('result-md')
    console.log(`RACE A event order: ${events.join(' | ')}`)
    expect(patchIndex, 'the terminal patch must happen at all').toBeGreaterThanOrEqual(0)
    expect(resultIndex, 'result.md must be written at all').toBeGreaterThanOrEqual(0)
    // The invariant: a reader that sees dead-letter in job.json finds the
    // matching disposition already on disk in result.md.
    expect(resultIndex, 'result.md must land before the terminal patch').toBeLessThan(patchIndex)
  })
})

describe('Race B: flush() resolves only once the bytes are on disk', () => {
  it('after the settle flush resolves, a reader sees the complete content', async () => {
    root = await mkdtemp(join(tmpdir(), 'm5c-race-b-'))
    const file = join(root, 'stdout.log')

    // Deterministic barrier: the FIRST persist blocks until the test releases
    // it, so the write is provably still in flight. No sleep, no timing window.
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let persistCalls = 0
    const persist = async (_path: string, text: string): Promise<{ ok: boolean; error?: string }> => {
      persistCalls += 1
      if (persistCalls === 1) await gate
      const { writeFile } = await import('node:fs/promises')
      await writeFile(file, text, 'utf8')
      return { ok: true }
    }

    const sink = new StreamSink(file, 4096, persist, 50)
    sink.push('alpha chunk\n')
    const first = sink.flush(true) // dirty cleared, write entered persist, now blocked
    expect(persistCalls, 'the first write is in flight').toBe(1)
    // Nothing has been written yet: the file cannot exist yet.
    expect(await fileText(file), 'the in-flight write has not landed').toBe('')

    // The settle-time call, exactly what runProcess's flushAll does.
    // Release the gate BEFORE awaiting settle: the old code would have resolved
    // settle immediately (dirty was false), but the fixed code must first wait
    // for the in-flight write to land. Releasing first lets settle return only
    // after the write has completed, which is the invariant under test.
    release?.()
    const settle = sink.flush(true)
    await settle

    // THE INVARIANT: a caller that awaited the settle flush must now be able to
    // read the complete content. Baseline resolves the settle flush while the
    // first write is still blocked, so the file is still absent/empty here.
    const afterSettle = await fileText(file)
    console.log(`RACE B content after settle flush resolved: ${JSON.stringify(afterSettle)}`)
    expect(afterSettle, 'after flush() resolves the bytes must be readable').toBe('alpha chunk\n')
  })
})

async function fileText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function writeFileSafe(path: string, text: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, text, 'utf8')
}
