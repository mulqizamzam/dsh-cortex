import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import type { HostContextShape, ToolDefinition } from '../../src/host/dsh.ts'
import type { CortexConfig, DelegationConfig, Job, ResolvedConfig, RunnerSpec } from '../../src/host/types.ts'
import * as delegate from '../../src/host/modules/delegate/index.ts'
import { TASK_FILE_TOKEN } from '../../src/host/modules/delegate/types.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'

/**
 * RETRY-CHAIN PROOF at the REAL production backoff.
 *
 * The shipped profile config (profiles/web/cordis.patch.yml) sets
 *   retry: { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 30000 }
 * so the chain must take 2s + 4s + 8s = 14s of backoff across 4 process
 * attempts. The existing suite in delegate.spec.ts accelerates this to
 * baseDelayMs 50 to stay fast, which proves the LOGIC but not the real
 * schedule. This file keeps the production numbers and records the actual
 * observed transitions.
 *
 * The runner is a real node child process that exits 1 (fixtures/fail-runner.mjs)
 * — a genuine OS process, real spawn, real signal/exit handling, real timers.
 * Nothing about the retry decision is mocked or stubbed.
 *
 * TWO independent observers, because they disagree in an informative way:
 *   1. updateJob spy  — authoritative; records every status the service writes.
 *   2. job.json poll  — what an operator calling cortex_delegate_status sees.
 */

const FAIL = fileURLToPath(new URL('./fixtures/fail-runner.mjs', import.meta.url))

/** The exact retry block from the live profile. */
const PRODUCTION_RETRY = { maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 30000 }

interface Transition {
  at: number
  status: string
  retryCount?: number
  nextRetryAt?: string
  lastError?: string
}

describe('delegate · retry chain at real production backoff', () => {
  it('fails 4x through 2s/4s/8s backoff and lands in dead-letter', async () => {
    const root = await makeTempRoot('dsh-cortex-retrychain-')
    const runnerSpec = (argv: string[]): RunnerSpec => ({
      argv,
      description: 'production-shaped failing runner',
      timeoutSec: 0,
      env: {},
    })
    const delegation: DelegationConfig = {
      ...DEFAULT_CONFIG.delegation,
      enabled: true,
      retry: PRODUCTION_RETRY,
      runners: { failAlways: runnerSpec([process.execPath, FAIL, TASK_FILE_TOKEN]) },
    }
    const cfg: ResolvedConfig = resolveConfig({ stateRoot: root, delegation } as CortexConfig)
    const tools = new Map<string, ToolDefinition>()
    const logs: string[] = []
    const store = new CortexStore({ root, caps: () => cfg.caps, warn: () => {} })
    const ctx = {
      tools: {
        register: (definition: ToolDefinition): (() => void) => {
          tools.set(definition.name, definition)
          return () => {}
        },
      },
      settings: { writable: false, register: () => { throw new Error('unused') } },
      agents: { get: () => undefined, roots: () => [] },
      get: () => undefined,
      inject: () => undefined,
      on: () => () => {},
      effect: (cb: () => (() => unknown) | void) => {
        const disposer = cb()
        return () => { if (typeof disposer === 'function') disposer() }
      },
    } as unknown as HostContextShape
    await store.init()
    delegate.apply({
      ctx,
      cfg: () => cfg,
      store,
      log: (m: string) => { logs.push(m) },
      warn: () => {},
      runtime: () => ({ modules: [], errors: [] }),
    } as never)
    const svc = delegate.getDelegateService()
    if (svc === null) throw new Error('delegate service missing after apply')

    // --- observer 1: authoritative spy over the real store writes -----------
    const writes: Transition[] = []
    const t0 = Date.now()
    const realUpdate = store.updateJob.bind(store)
    store.updateJob = async (id: string, patch: Partial<Job>): Promise<Awaited<ReturnType<typeof realUpdate>>> => {
      if (patch.status !== undefined) {
        writes.push({
          at: Date.now() - t0,
          status: patch.status,
          ...(patch.retryCount !== undefined ? { retryCount: patch.retryCount } : {}),
          ...(patch.nextRetryAt !== undefined ? { nextRetryAt: patch.nextRetryAt } : {}),
        })
      }
      return await realUpdate(id, patch)
    }

    // --- observer 2: what cortex_delegate_status would report --------------
    const polls: Transition[] = []
    let lastPoll = ''

    const tool = tools.get('cortex_delegate')
    if (tool === undefined) throw new Error('cortex_delegate not registered')
    const out = (await tool.execute(
      { runner: 'failAlways', task: 'prove the real backoff chain' } as never,
      { signal: new AbortController().signal } as never,
    )) as Record<string, unknown>
    const jobId = String((out.job as { id: string }).id)

    // poll the real job.json the way the status tool does
    const pollTimer = setInterval(() => {
      void (async () => {
        const job = await svc.getJob(jobId)
        if (job === null) return
        const key = `${job.status}:${job.retryCount ?? 0}`
        if (key === lastPoll) return
        lastPoll = key
        polls.push({
          at: Date.now() - t0,
          status: job.status,
          ...(job.retryCount !== undefined ? { retryCount: job.retryCount } : {}),
          ...(job.nextRetryAt !== undefined ? { nextRetryAt: job.nextRetryAt } : {}),
          ...(job.lastError !== undefined ? { lastError: job.lastError } : {}),
        })
      })()
    }, 25)

    // wait for the terminal dead-letter state
    const deadline = Date.now() + 60_000
    let final: Transition | undefined
    for (;;) {
      const job = await svc.getJob(jobId)
      if (job?.status === 'dead-letter') {
        final = { at: Date.now() - t0, status: job.status, retryCount: job.retryCount }
        break
      }
      if (Date.now() > deadline) break
      await new Promise(r => setTimeout(r, 40))
    }
    clearInterval(pollTimer)

    const totalMs = Date.now() - t0
    const queuedWrites = writes.filter(w => w.status === 'queued')
    const runningWrites = writes.filter(w => w.status === 'running')
    const report = {
      totalMs,
      authoritativeWrites: writes,
      runningAttempts: runningWrites.length,
      backoffWaits: queuedWrites.map(q => q.at),
      observedByPolling: polls,
      final,
    }

    // restore the spy before assertions so teardown is unaffected
    store.updateJob = realUpdate
    for (const id of svc.activeIds()) await svc.cancel(id)
    await removeTempRoot(root)

    // ---- assertions -------------------------------------------------------
    // 4 real process attempts: initial + 3 retries
    expect(runningWrites.length, 'expected 4 real spawns').toBe(4)
    // 3 backoff waits, each preceded by a queued patch
    expect(queuedWrites.length, 'expected 3 backoff waits').toBe(3)
    // dead-letter is reached
    expect(final?.status, 'job must land in dead-letter').toBe('dead-letter')
    expect(final?.retryCount, 'all 3 retries consumed').toBe(3)
    // real production schedule: total >= 2+4+8 = 14s of backoff
    expect(totalMs, 'real backoff 2+4+8s must have elapsed').toBeGreaterThanOrEqual(13_500)
    // and the per-attempt gaps follow base*2^(n-1): 2s, 4s, 8s
    const gaps: number[] = []
    for (let i = 1; i < runningWrites.length; i += 1) gaps.push(runningWrites[i]!.at - runningWrites[i - 1]!.at)
    expect(gaps.length, 'expected 3 inter-attempt gaps').toBe(3)
    expect(gaps[0]).toBeGreaterThanOrEqual(1_800)   // ~2s
    expect(gaps[1]).toBeGreaterThanOrEqual(3_800)   // ~4s
    expect(gaps[2]).toBeGreaterThanOrEqual(7_800)   // ~8s

    // The reason must be observable from a POLL during the queued backoff
    // window. Polling never sees `failed` (it lasts <1ms), so `lastError` is
    // the only field that carries it — without it the whole wait reads as
    // "queued, exit —" with no cause.
    const queuedPolls = polls.filter(p => p.status === 'queued')
    expect(queuedPolls.length, 'polling must observe the backoff windows').toBeGreaterThanOrEqual(3)
    for (const poll of queuedPolls) {
      expect(poll.lastError, 'every queued poll carries the failure reason').toBe('exit code 1')
    }

    // emit the full evidence trail for the report
    process.stdout.write(`\n=== RETRY CHAIN EVIDENCE (production backoff 2s/4s/8s) ===\n${JSON.stringify(report, null, 2)}\n=== END ===\n`)
  }, 90_000)
})
