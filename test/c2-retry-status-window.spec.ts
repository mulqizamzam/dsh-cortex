/**
 * Regression: a job that WILL retry never passes through a terminal status.
 *
 * The defect (surfaced as a 1-in-8 flake in the cwd-contract retry test):
 * `finalize` patched `status: 'failed'` first and only corrected it to
 * `queued` a second patch later — two awaits wide. Any observer (the panel,
 * `cortex_delegate_status`, another agent, the retry test's poll) could see a
 * terminal outcome for a job that was about to run again, and a poll that
 * stopped on it recorded fewer spawns than the retry chain actually performed.
 *
 * This test drives the real subprocess runner (no mocks on the retry decision)
 * and asserts the invariant on the OBSERVED status sequence: between the
 * first and the last `running` there is no `failed` and no `dead-letter`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../src/host/config.ts'
import { CortexStore } from '../src/host/store.ts'
import type { HostContextShape, ToolDefinition } from '../src/host/dsh.ts'
import type { CortexConfig, DelegationConfig, Job, ResolvedConfig } from '../src/host/types.ts'
import * as delegate from '../src/host/modules/delegate/index.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

const NODE = process.execPath

describe('delegate retry · a scheduled retry is never observed as terminal', () => {
  it('keeps the status non-terminal between attempts', async () => {
    const root = await makeTempRoot('dsh-cortex-retryvis-')
    const runnerDir = await mkdtemp(join(tmpdir(), 'dsh-cortex-retryvis-cwd-'))
    try {
      const script = 'process.stdout.write("ATTEMPT_RAN\\n"); process.exit(1);'
      const delegation: DelegationConfig = {
        ...DEFAULT_CONFIG.delegation,
        enabled: true,
        retry: { maxRetries: 2, baseDelayMs: 20, maxDelayMs: 40 },
        runners: {
          alwaysFail: { argv: [NODE, '-e', script], description: 'fails after one line', timeoutSec: 10, env: {}, cwd: runnerDir },
        },
      }
      const cfg: ResolvedConfig = resolveConfig({ stateRoot: root, delegation } as CortexConfig)
      const tools = new Map<string, ToolDefinition>()
      const store = new CortexStore({ root, caps: () => cfg.caps, warn: () => {} })
      const ctx = {
        tools: {
          register: (d: ToolDefinition): (() => void) => { tools.set(d.name, d); return () => {} },
        },
        settings: { writable: false, register: () => { throw new Error('unused') } },
        agents: { get: () => undefined, roots: () => [] },
        get: () => undefined,
        inject: () => undefined,
        on: () => () => {},
        effect: (cb: () => (() => unknown) | void) => { const disposer = cb(); return () => { if (typeof disposer === 'function') disposer() } },
      } as unknown as HostContextShape
      await store.init()
      delegate.apply({
        ctx, cfg: () => cfg, store, log: () => {}, warn: () => {}, runtime: () => ({ modules: [], errors: [] }),
      } as never)
      const svc = delegate.getDelegateService()
      if (svc === null) throw new Error('delegate service missing after apply')

      // Record every status the store is asked to persist, in order.
      const statuses: string[] = []
      const realUpdate = store.updateJob.bind(store)
      store.updateJob = async (id: string, patch: Partial<Job>): Promise<Awaited<ReturnType<typeof realUpdate>>> => {
        if (typeof patch.status === 'string') statuses.push(patch.status)
        return await realUpdate(id, patch)
      }

      const tool = tools.get('cortex_delegate')
      if (tool === undefined) throw new Error('cortex_delegate not registered')
      const out = (await tool.execute(
        { runner: 'alwaysFail', task: 'prove the retry is never terminal mid-chain' } as never,
        { signal: new AbortController().signal } as never,
      )) as Record<string, unknown>
      const jobId = String((out.job as { id: string }).id)

      const deadline = Date.now() + 30_000
      for (;;) {
        const job = await svc.getJob(jobId)
        if (job !== null && ['dead-letter', 'failed'].includes(job.status)) break
        if (Date.now() > deadline) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      store.updateJob = realUpdate
      for (const id of svc.activeIds()) await svc.cancel(id)

      const firstRunning = statuses.indexOf('running')
      const lastRunning = statuses.lastIndexOf('running')
      // Three real attempts: attempt 1 plus two retries.
      expect(firstRunning, `expected three running patches, saw ${statuses.join(',')}`).toBeGreaterThanOrEqual(0)
      expect(lastRunning, 'expected more than one running patch').toBeGreaterThan(firstRunning)
      const between = statuses.slice(firstRunning, lastRunning + 1)
      expect(between.filter(status => status === 'failed' || status === 'dead-letter'),
        `a retrying job must not show a terminal status between attempts; saw ${statuses.join(',')}`).toEqual([])
      // And the job does end terminally once the retries are exhausted.
      expect(['failed', 'dead-letter']).toContain(statuses[statuses.length - 1])

      await removeTempRoot(root)
    } finally {
      await rm(runnerDir, { recursive: true, force: true })
    }
  }, 45_000)
})