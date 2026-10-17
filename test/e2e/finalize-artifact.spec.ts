/**
 * E2E proof: a delegate job that cannot write its artifact gets NO disposition.
 *
 * `finalize()` writes result.md first and job.json's terminal status second, and
 * its own comment states the invariant: "result.md always lands BEFORE job.json
 * goes terminal". Both result.md writes sat in `try { ... } catch { warn }`, so a
 * failing write was reported and then execution carried on into the
 * unconditional terminal patch — a real write failure (ENOSPC, EACCES, a
 * read-only state root) produced a job.json claiming killed/failed/dead-letter
 * with no artifact behind it. With the fix the job is recorded as `lost`
 * (terminal, holds no concurrency slot, carries the reason on the row).
 *
 * The unit test (test/delegate/finalize-artifact.spec.ts) pins that mechanism by
 * calling `svc.finalize()` directly. This file goes through the boundary a real
 * session uses — `apply(ctx, config)` and
 * `ctx.tools.get(name).execute(args, {signal})` — so the proof covers the tool
 * contract too: dispatch → cancel → status, i.e. the shapes a caller actually
 * sees. The reproduction is the same real filesystem error, not a patched seam:
 * result.md is created as a DIRECTORY, so the atomic rename onto it fails.
 *
 * One `apply()` per file, on purpose: `delegate` exposes no service reset, so a
 * second apply would reuse singletons bound to the previous state root.
 */
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../../src/host/index.ts'
import { getDelegateService } from '../../src/host/modules/delegate/index.ts'
import { DEFAULT_CONFIG } from '../../src/host/config.ts'
import type { CortexStore } from '../../src/host/store.ts'
import type { ToolDefinition } from '../../src/host/dsh.ts'

/** The real fixture: the job must stay ALIVE while the artifact is broken. */
const SLEEP = fileURLToPath(new URL('../delegate/fixtures/sleep-runner.mjs', import.meta.url))

/** Statuses that claim a disposition, i.e. that a result.md exists to back it. */
const DISPOSITIONS = ['succeeded', 'failed', 'dead-letter', 'killed', 'timeout']

let root = ''
let tools: Map<string, ToolDefinition>
let store: CortexStore

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-e2e-finalize-'))
  tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
      get: (name: string) => tools.get(name),
    },
    agents: { get: () => undefined, roots: () => [] },
    get(name: string) {
      if (name === 'dshHomePath') return (...segments: string[]) => join(root, ...segments)
      return undefined
    },
    inject: (_services: string[], callback: (context: unknown) => void) => { callback(ctx) },
    on: () => () => {},
    effect: (callback: () => unknown) => { callback(); return () => {} },
  } as never

  apply(ctx, {
    stateRoot: root,
    delegation: {
      ...DEFAULT_CONFIG.delegation,
      enabled: true,
      maxConcurrent: 2,
      runners: {
        sleepy: { argv: [process.execPath, SLEEP, '30000'], description: 'sleeps', timeoutSec: 0, env: {} },
      },
    },
  } as never)

  const svc = getDelegateService()
  if (svc === null) throw new Error('delegate service was not bound by apply()')
  store = (svc as unknown as { deps: { store: CortexStore } }).deps.store
  await store.init()
})

afterAll(async () => {
  const svc = getDelegateService()
  if (svc !== null) for (const id of svc.activeIds()) await svc.cancel(id).catch(() => {})
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

async function runTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return await tool.execute(args as never, { signal: new AbortController().signal }) as Record<string, unknown>
}

/** `cortex_delegate_status {jobId}` → `{status:'ok', job: viewOf(job)}`. */
async function jobOf(jobId: string): Promise<Record<string, unknown>> {
  const result = await runTool('cortex_delegate_status', { jobId })
  const job = result.job as Record<string, unknown> | undefined
  if (job === undefined) throw new Error(`cortex_delegate_status returned no job: ${JSON.stringify(result)}`)
  return job
}

/** Bounded poll: the whole test must not outlive the runner's 30 s sleep. */
async function waitForStatus(
  jobId: string,
  wanted: (status: string) => boolean,
  budgetMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + budgetMs
  let job = await jobOf(jobId)
  while (!wanted(String(job.status))) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(budgetMs)}ms; last status ${String(job.status)}`)
    await new Promise(resolve => setTimeout(resolve, 25))
    job = await jobOf(jobId)
  }
  return job
}

describe('E2E through the real tool surface', () => {
  it('records an unwritable-artifact job as lost, never a disposition', async () => {
    const dispatched = await runTool('cortex_delegate', { runner: 'sleepy', task: 'artifact contract e2e' })
    expect(dispatched.status, JSON.stringify(dispatched)).toBe('dispatched')
    const jobId = String((dispatched.job as Record<string, unknown>).id)
    expect(jobId).not.toBe('')

    // The run must be LIVE while the artifact is broken. `cancel()` on a job
    // with no process owned by this host marks it `lost` immediately
    // (service.ts, the "no live process here" branch), and that path would
    // satisfy the final assertion for entirely the wrong reason.
    const live = await waitForStatus(jobId, status => status === 'running', 5_000)
    expect(live.status).toBe('running')

    // A real, unwritable destination for the atomic rename: `rename(tmp, path)`
    // onto a directory fails, so result.md can never land.
    const resultPath = store.jobPaths(jobId).result
    await mkdir(resultPath, { recursive: true })
    expect((await stat(resultPath)).isDirectory(), 'result.md must be a directory').toBe(true)

    const cancelled = await runTool('cortex_delegate_cancel', { jobId })
    expect(cancelled.status, JSON.stringify(cancelled)).toBe('ok')

    const settled = await waitForStatus(jobId, status => status !== 'queued' && status !== 'running', 8_000)
    console.log(`E2E FINALIZE status=${String(settled.status)} lastError=${String(settled.lastError)}`)

    // The invariant: no disposition without the artifact.
    expect(DISPOSITIONS).not.toContain(String(settled.status))
    expect(settled.status).toBe('lost')
    // ...and lost for the ARTIFACT reason, not the no-live-process one.
    expect(String(settled.lastError)).toContain('result.md could not be written:')
    // The artifact really is still absent: the path is the directory we made.
    expect((await stat(resultPath)).isDirectory()).toBe(true)
  })
})
