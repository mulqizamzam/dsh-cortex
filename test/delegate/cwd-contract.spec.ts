import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import type { HostContextShape, ToolDefinition } from '../../src/host/dsh.ts'
import type { CortexConfig, DelegationConfig, Job, ResolvedConfig } from '../../src/host/types.ts'
import * as delegate from '../../src/host/modules/delegate/index.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * TWO GATES on the delegation `cwd` contract. Both exist because the rule is a
 * single conditional that no test covered: the whole point of the feature is
 * that the directory is decided by config and not by the task text, so a change
 * that weakened it would be invisible to a green suite.
 *
 *  1. `resolveConfig` drops every cwd that is not an absolute POSIX path. A
 *     relative path surviving normalisation would resolve against the host
 *     process's own cwd at spawn time — an arbitrary directory, chosen by
 *     whatever started DSH.
 *  2. A RETRY runs where attempt 1 ran. The regression this pins: runRetry()
 *     hardcoded the state root while dispatch used the runner's configured
 *     cwd, so attempt 1 worked in the configured directory and every retry
 *     silently moved to the state root — while job.json, result.md and the
 *     conflict claim all still named the configured directory.
 */

const NODE = process.execPath

describe('delegation cwd · normalisation', () => {
  it('keeps an absolute cwd and drops relative, tilde, Windows and empty ones', () => {
    const runnerWith = (cwd: string): { delegation: { runners: Record<string, { cwd?: string }> } } => {
      const resolved = resolveConfig({
        stateRoot: '/tmp/state-root',
        delegation: {
          runners: {
            r: { argv: [NODE, '-e', '0'], description: '', timeoutSec: 0, env: {}, cwd },
          },
        },
      } as unknown as CortexConfig)
      return resolved as unknown as { delegation: { runners: Record<string, { cwd?: string }> } }
    }

    // Absolute POSIX path is honoured — this is the feature.
    expect(runnerWith('/etc').delegation.runners.r.cwd).toBe('/etc')
    expect(runnerWith('/home/administrator/agent-workspace').delegation.runners.r.cwd)
      .toBe('/home/administrator/agent-workspace')

    // Everything else must vanish, leaving dispatch to fall back to the state
    // root. '~/x' in particular must not expand to a home directory, and
    // 'C:\\x' must not be mistaken for an absolute path.
    for (const bad of ['rel/path', './rel', '~/x', '~', 'C:\\x', 'C:/x', '', '   ']) {
      expect(runnerWith(bad).delegation.runners.r.cwd, `cwd ${JSON.stringify(bad)} must be dropped`).toBeUndefined()
    }
  })
})

describe('delegation cwd · a retry runs where attempt 1 ran', () => {
  it('keeps the runner-configured cwd across the retry chain', async () => {
    const root = await makeTempRoot('dsh-cortex-retrycwd-')
    const runnerDir = await mkdtemp(join(tmpdir(), 'dsh-cortex-runnercwd-'))
    try {
      // A real OS process: it prints the directory it was actually started in,
      // then exits 1 so the retry chain engages. Nothing about the decision to
      // retry is mocked — the assertion reads the child's own stdout.
      const script = 'process.stdout.write("ACTUAL_CWD=" + process.cwd() + "\\n"); process.exit(1);'
      const delegation: DelegationConfig = {
        ...DEFAULT_CONFIG.delegation,
        enabled: true,
        retry: { maxRetries: 2, baseDelayMs: 20, maxDelayMs: 40 },
        runners: {
          failWithCwd: { argv: [NODE, '-e', script], description: 'prints its cwd, then fails', timeoutSec: 10, env: {}, cwd: runnerDir },
        },
      }
      const cfg: ResolvedConfig = resolveConfig({ stateRoot: root, delegation } as CortexConfig)
      const tools = new Map<string, ToolDefinition>()
      const store = new CortexStore({ root, caps: () => cfg.caps, warn: () => {} })
      const ctx = {
        tools: {
          register: (d: ToolDefinition): (() => void) => {
            tools.set(d.name, d)
            return () => {}
          },
        },
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
        log: () => {},
        warn: () => {},
        runtime: () => ({ modules: [], errors: [] }),
      } as never)
      const svc = delegate.getDelegateService()
      if (svc === null) throw new Error('delegate service missing after apply')

      // Record the cwd of EVERY spawn by watching the real store writes.
      const spawnCwds: string[] = []
      const realUpdate = store.updateJob.bind(store)
      store.updateJob = async (id: string, patch: Partial<Job>): Promise<Awaited<ReturnType<typeof realUpdate>>> => {
        if (patch.status === 'running') {
          const job = (await svc.getJob(id)) ?? undefined
          if (job?.cwd !== undefined) spawnCwds.push(job.cwd)
        }
        return await realUpdate(id, patch)
      }

      const tool = tools.get('cortex_delegate')
      if (tool === undefined) throw new Error('cortex_delegate not registered')
      const out = (await tool.execute(
        { runner: 'failWithCwd', task: 'prove the retry keeps the configured cwd' } as never,
        { signal: new AbortController().signal } as never,
      )) as Record<string, unknown>
      const jobId = String((out.job as { id: string }).id)

      const deadline = Date.now() + 30_000
      for (;;) {
        const job = await svc.getJob(jobId)
        if (job !== null && ['dead-letter', 'failed'].includes(job.status)) break
        if (Date.now() > deadline) break
        await new Promise(r => setTimeout(r, 50))
      }
      store.updateJob = realUpdate
      for (const id of svc.activeIds()) await svc.cancel(id)

      // What the child process itself reported it was running in.
      const stdout = await readFile(join(root, 'delegation', 'jobs', jobId, 'stdout.log'), 'utf8')
      const reported = /ACTUAL_CWD=(.+)/.exec(stdout)?.[1]?.trim()

      // Three real spawns: attempt 1 plus two retries.
      expect(spawnCwds.length, 'expected 3 real spawns (1 attempt + 2 retries)').toBe(3)
      // Every one of them, including both retries, in the configured directory.
      for (const cwd of spawnCwds) {
        expect(cwd, 'every attempt must use the runner-configured cwd').toBe(runnerDir)
      }
      expect(reported, 'the child process reported its own cwd').toBe(runnerDir)
      // And explicitly not the state root the regression fell back to.
      expect(reported, 'a retry must not silently move to the state root').not.toBe(root)

      await removeTempRoot(root)
    } finally {
      await rm(runnerDir, { recursive: true, force: true })
    }
  }, 45_000)
})
