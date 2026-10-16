/**
 * `delegation.maxConcurrent` must hold under CONCURRENT dispatch, not just
 * sequential dispatch.
 *
 * `dispatch` read capacity (`await this.listJobs(500)`, counting live jobs) and
 * then created the job (`await store.createJob(...)`) several awaits later, with
 * nothing spanning the two. Overlapping dispatches all read the same pre-create
 * count and all passed, so the cap was exact when calls were serialized and
 * unbounded when they were not — and concurrent dispatch is the whole point of a
 * multi-agent room.
 *
 * The barrier delays the FIRST capacity read by a fixed interval rather than
 * waiting for N callers to arrive. That distinction matters: a "wait for three
 * arrivals" barrier is incompatible with a correct fix, because a correct fix
 * stops the second and third caller from ever reaching that point and would
 * deadlock instead of failing. A timer releases either way, so this test can
 * actually tell the two behaviours apart.
 *
 * The runner sleeps, so created jobs stay live for the whole window. With an
 * instant runner the first two would finish and legitimately free their slots,
 * and a third acceptance would prove nothing.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import { DelegateService } from '../../src/host/modules/delegate/service.ts'

const SLEEP = fileURLToPath(new URL('./fixtures/sleep-runner.mjs', import.meta.url))

let root = ''

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('maxConcurrent holds when dispatches overlap', () => {
  it('accepts no more than the cap', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-capacity-'))
    const cfg = resolveConfig({
      ...DEFAULT_CONFIG,
      delegation: {
        ...DEFAULT_CONFIG.delegation,
        enabled: true,
        maxConcurrent: 2,
        runners: { sleepy: { argv: [process.execPath, SLEEP, '30000'], description: 'sleeps', timeoutSec: 0, env: {} } },
      },
    })
    const store = new CortexStore({ root, caps: () => cfg.caps })
    await store.init()
    const deps = {
      ctx: { tools: { register: () => () => {} }, agents: { get: () => undefined, roots: () => [] }, on: () => () => {}, effect: (fn: () => unknown) => fn() },
      cfg: () => cfg,
      store,
      log: () => {},
      warn: () => {},
      runtime: () => ({ modules: [], errors: [] }),
    } as never
    const svc = new DelegateService(deps)

    // Hold EVERY capacity read until all three dispatches have arrived — or
    // until the timer fires, whichever comes first.
    //
    // The timer is the load-bearing part. Without it this barrier would wait for
    // three arrivals that a correct fix makes impossible (the second and third
    // callers park on the lock and never reach the read), so the test would hang
    // instead of passing. With it, the unfixed code still gets its full overlap
    // — all three reads land before any create — and the fixed code is released
    // one caller at a time.
    const attempts = 3
    let reads = 0
    let releaseAll: (() => void) | undefined
    const allArrived = new Promise<void>(resolve => { releaseAll = resolve })
    const timer = setTimeout(() => releaseAll?.(), 200)
    const realListJobs = store.listJobs.bind(store)
    ;(store as unknown as { listJobs: typeof store.listJobs }).listJobs = async () => {
      reads += 1
      if (reads >= attempts) releaseAll?.()
      await allArrived
      return await realListJobs()
    }
    let accepted = 0
    try {
      const settled = await Promise.all(
        Array.from({ length: attempts }, () => svc.dispatch({ runner: 'sleepy', task: 'capacity probe' })),
      )
      accepted = settled.filter(result => result.ok === true).length
    } finally {
      clearTimeout(timer)
      for (const id of svc.activeIds()) await svc.cancel(id).catch(() => {})
    }
    console.log(`CAPACITY accepted=${String(accepted)} of ${String(attempts)}, maxConcurrent=${String(cfg.delegation.maxConcurrent)}`)

    expect(accepted).toBeLessThanOrEqual(cfg.delegation.maxConcurrent)
  })
})
