import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readTextSafe, sizeOf, writeTextAtomic } from '../../src/lib/fsx.ts'
import { isoDate } from '../../src/lib/ids.ts'
import { projectId as computeProjectId } from '../../src/lib/pid.ts'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import type { HostAgent, HostContextShape, ToolDefinition } from '../../src/host/dsh.ts'
import type { CortexConfig, DelegationConfig, Job, ResolvedConfig, RunnerSpec } from '../../src/host/types.ts'
import * as delegate from '../../src/host/modules/delegate/index.ts'
import { RESULT_HEADER, TASK_FILE_TOKEN, WRITE_BACK_LABEL } from '../../src/host/modules/delegate/types.ts'
import { buildArgv } from '../../src/host/modules/delegate/service.ts'
import type { DelegateService } from '../../src/host/modules/delegate/service.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'

/**
 * M6 acceptance tests (BRIEFS §M6, TEST-PLAN G11 shape). The runner is a local
 * echo/sleep NODE fixture — never `hermes`: unit tests must not need any
 * external CLI, network, or user config.
 */

const ECHO = fileURLToPath(new URL('./fixtures/echo-runner.mjs', import.meta.url))
const SLEEP = fileURLToPath(new URL('./fixtures/sleep-runner.mjs', import.meta.url))
const SPAM = fileURLToPath(new URL('./fixtures/spam-runner.mjs', import.meta.url))
const FAIL = fileURLToPath(new URL('./fixtures/fail-runner.mjs', import.meta.url))

function runner(argv: string[], extra: Partial<RunnerSpec> = {}): RunnerSpec {
  return { argv, description: 'test fixture runner', timeoutSec: 0, env: { CORTEX_FIXTURE_PROBE: 'on' }, ...extra }
}

function delegation(partial: Partial<DelegationConfig> = {}): DelegationConfig {
  return { ...DEFAULT_CONFIG.delegation, enabled: true, ...partial }
}

interface Harness {
  deps: ModuleDepsLite
  cfg: ResolvedConfig
  store: CortexStore
  tools: Map<string, ToolDefinition>
  logs: string[]
  warnings: string[]
  root: string
}

interface ModuleDepsLite {
  ctx: HostContextShape
  cfg(): ResolvedConfig
  store: CortexStore
  log(m: string): void
  warn(m: string): void
  runtime(): { modules: []; errors: string[] }
}

function makeHarness(config: Partial<CortexConfig>, root: string): Harness {
  const cfg = resolveConfig({ ...config, stateRoot: root } as CortexConfig)
  const tools = new Map<string, ToolDefinition>()
  const logs: string[] = []
  const warnings: string[] = []
  const store = new CortexStore({ root, caps: () => cfg.caps, warn: m => warnings.push(m) })
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    settings: { writable: false, register: () => { throw new Error('settings unused by delegate') } },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    inject: () => undefined,
    on: () => () => {},
    effect: (cb: () => (() => unknown) | void) => {
      const disposer = cb()
      return () => { if (typeof disposer === 'function') disposer() }
    },
  } as unknown as HostContextShape
  const deps: ModuleDepsLite = {
    ctx,
    cfg: () => cfg,
    store,
    log: m => { logs.push(m) },
    warn: m => { warnings.push(m) },
    runtime: () => ({ modules: [], errors: [] }),
  }
  return { deps, cfg, store, tools, logs, warnings, root }
}

type Live = Harness & { svc: DelegateService }

/** One boot per test: fresh tmp state root, delegate module applied, tools captured. */
async function boot(partial: Partial<DelegationConfig>, extra: Partial<CortexConfig> = {}): Promise<Live> {
  const root = await makeTempRoot('dsh-cortex-m6-')
  const harness = makeHarness({ ...extra, delegation: delegation({ runners: RUNNERS, ...partial }) }, root)
  await harness.store.init()
  delegate.apply(harness.deps)
  const svc = delegate.getDelegateService()
  if (svc === null) throw new Error('delegate service missing after apply')
  return { ...harness, svc }
}

const RUNNERS = {
  echoFile: runner([process.execPath, ECHO, TASK_FILE_TOKEN]),
  echoAppend: runner([process.execPath, ECHO]),
  sleepLong: runner([process.execPath, SLEEP, '30000']),
  sleep10: runner([process.execPath, SLEEP, '10000'], { timeoutSec: 1 }),
  spam: runner([process.execPath, SPAM, '300']),
  failAlways: runner([process.execPath, FAIL]),
}

/** Cancel every live child, then drop the tmp root. */
async function teardown(h: Live): Promise<void> {
  for (const id of h.svc.activeIds()) await h.svc.cancel(id)
  await until('children drained', async () => (h.svc.activeIds().length === 0 ? true : null), 5000).catch(() => {})
  await removeTempRoot(h.root)
}

function callTool(h: Harness, name: string, args: Record<string, unknown>, agent?: HostAgent): Promise<Record<string, unknown>> {
  const tool = h.tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  return tool.execute(args as never, { signal: new AbortController().signal, ...(agent ? { agent } : {}) }) as Promise<Record<string, unknown>>
}

async function until<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 9000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

function processDead(pid: string | undefined): boolean {
  if (pid === undefined) return true
  try {
    process.kill(Number(pid), 0)
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------

describe('delegate · gates + argv safety', () => {
  it('exports the module face and registers all five tools', async () => {
    const h = await boot({})
    try {
      expect(delegate.name).toBe('delegate')
      expect([...delegate.TOOLS]).toEqual(['cortex_delegate', 'cortex_delegate_status', 'cortex_delegate_logs', 'cortex_delegate_result', 'cortex_delegate_cancel', 'cortex_delegate_retry'])
      for (const id of delegate.TOOLS) expect(h.tools.has(id), id).toBe(true)
      expect(delegate.readEndpoints['jobs.list']).toBeTypeOf('function')
      expect(delegate.writeEndpoints['jobs.cancel']).toBeTypeOf('function')
      // P9 / #53: no model-visible TEXT carries a brace pair. The JSON
      // envelope of `parameters` legitimately serializes adjacent braces
      // (`}}` where objects nest), so walk the string leaves only.
      const stringsIn = (value: unknown, out: string[]): string[] => {
        if (typeof value === 'string') out.push(value)
        else if (Array.isArray(value)) for (const item of value) stringsIn(item, out)
        else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, out)
        return out
      }
      for (const def of h.tools.values()) {
        for (const text of stringsIn(def.description, []).concat(stringsIn(def.parameters, []))) {
          expect(text).not.toMatch(/\{\{|\}\}/)
        }
      }
    } finally {
      await teardown(h)
    }
  })

  it('enabled=false refuses dispatch, naming the config keys, without creating a job', async () => {
    const h = await boot({ enabled: false })
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'echoFile', task: 'anything' })
      expect(out.status).toBe('refused')
      expect(String(out.message)).toContain('delegation.enabled')
      expect(String(out.message)).toContain('delegation.runners')
      expect((await h.svc.listJobs(50)).jobs).toHaveLength(0)
    } finally {
      await teardown(h)
    }
  })

  it('an unregistered runner is refused; the empty default registry says so', async () => {
    const h = await boot({}) // registry has the echo fixtures; ask for a name that is not there
    const out = await callTool(h, 'cortex_delegate', { runner: 'hermes-not-configured', task: 'do it' })
    expect(out.status).toBe('refused')
    expect(String(out.message)).toMatch(/not registered/)
    expect(String(out.message)).toMatch(/known runners/)
    await teardown(h)
  })

  it('buildArgv keeps flag-like task text as ONE appended item; the placeholder replaces only itself', () => {
    const task = '-c rm -rf /'
    expect(buildArgv(['/bin/x', '--ask'], task, '/root/jobs/1/task.md')).toEqual(['/bin/x', '--ask', task])
    expect(buildArgv(['/bin/x', TASK_FILE_TOKEN, '--after'], task, '/T')).toEqual(['/bin/x', '/T', '--after'])
    expect(buildArgv(['/bin/x'], task, '/T')).toHaveLength(2)
  })

  it('task with flag-like/brace content reaches the child as data; argv shape survives; P9 pairs gone', async () => {
    const h = await boot({})
    try {
      const evil = '-c rm -rf / --drop {{session}} tables'
      const out = await callTool(h, 'cortex_delegate', { runner: 'echoAppend', task: evil })
      expect(out.status).toBe('dispatched')
      const jobId = String((out.job as { id: string }).id)
      await until('job settles with result', async () => {
        const j = await h.svc.getJob(jobId)
        return j?.status === 'succeeded' && (await h.svc.readResultFile(jobId)) !== null ? true : null
      })
      const log = (await h.svc.tail('stdout', jobId, 65536)).text
      const payload = JSON.parse(log.trim().split('\n').pop() ?? '{}') as { argv: string[] }
      expect(payload.argv).toHaveLength(1)
      // the store's write-edge neutralization reached the child: braces split, text is ONE data item
      expect(payload.argv[0]).toBe('-c rm -rf / --drop { {session} } tables')
      const result = (await h.svc.readResultFile(jobId)) ?? ''
      expect(result).toContain(RESULT_HEADER)
      expect(result).not.toMatch(/\{\{|\}\}/)
      expect('task' in (out.job as Record<string, unknown>)).toBe(false) // view carries taskChars only
    } finally {
      await teardown(h)
    }
  })

  it('external workdir refused (v1), out-of-root image refused, non-image extension refused — no jobs created', async () => {
    const h = await boot({})
    try {
      const w = await callTool(h, 'cortex_delegate', { runner: 'echoAppend', task: 't', workdir: '/tmp' })
      expect(String(w.message)).toMatch(/workdir is not supported yet/)
      const img = await callTool(h, 'cortex_delegate', { runner: 'echoAppend', task: 't', images: ['/etc/passwd'] })
      expect(String(img.message)).toMatch(/outside the plugin state root/)
      const ext = await callTool(h, 'cortex_delegate', { runner: 'echoAppend', task: 't', images: [join(h.root, 'notes.txt')] })
      expect(String(ext.message)).toMatch(/unsupported type/)
      expect((await h.svc.listJobs(50)).jobs).toHaveLength(0)
    } finally {
      await teardown(h)
    }
  })
})

describe('delegate · echo fixture end to end', () => {
  it('taskFile runner: task.md + result.md + labelled write-back (daily, project, pending, room) all land', async () => {
    const h = await boot({})
    try {
      const room = await h.store.createRoom({ title: 'm6 room' })
      const roomId = room.ok ? room.data.id : ''
      await h.store.addEntry({ scope: { track: 'user' }, content: 'Prefers terse answers', importance: 4 })
      const cwd = join(h.root, 'requester-project')
      const agent = { id: 'agent-1', status: 'idle', session: { header: { cwd } } } as unknown as HostAgent

      const out = await callTool(h, 'cortex_delegate', { runner: 'echoFile', task: 'Summarize the attached notes', includeMemory: true, roomId }, agent)
      const jobId = String((out.job as { id: string }).id)
      const done = await until('job succeeded with result.md written', async () => {
        const job = await h.svc.getJob(jobId)
        if (job?.status !== 'succeeded') return null
        return (await h.svc.readResultFile(jobId)) !== null ? job : null
      })
      expect(done.exitCode).toBe(0)
      expect(done.cwd).toBe(h.root)
      expect(processDead(done.pid), 'child is gone after exit').toBe(true)

      const taskMd = (await readTextSafe(join(h.store.jobPaths(jobId).dir, 'task.md'))) ?? ''
      expect(taskMd).toContain('## task')
      expect(taskMd).toContain('Summarize the attached notes')
      expect(taskMd).toContain('plugin memory context')
      expect(taskMd).toContain('Prefers terse answers')

      const log = (await h.svc.tail('stdout', jobId, 65536)).text
      const payload = JSON.parse(log.trim().split('\n').pop() ?? '{}') as { argv: string[]; cwd: string; probe: string | null; files: Record<string, string> }
      // child sees ONLY the substituted file path as its argv — task text never travels as text
      expect(payload.argv).toHaveLength(1)
      const taskPath = join(h.store.jobPaths(jobId).dir, 'task.md')
      expect(payload.argv[0]).toBe(taskPath)
      expect(payload.argv.join(' ')).not.toContain('Summarize the attached notes') // delivered by FILE, not argv text
      expect(payload.files[taskPath]).toContain('Summarize the attached notes')
      expect(payload.cwd).toBe(h.root)
      expect(payload.probe).toBe('on') // spec.env merged into {...process.env}

      const result = (await h.svc.readResultFile(jobId)) ?? ''
      expect(result).toContain(RESULT_HEADER)
      expect(result).toContain('dsh-cortex-m6-fixture')
      expect(result).toContain('## write-back')

      const daily = await h.store.logRead({ scope: 'daily', date: isoDate() })
      expect(daily.ok && daily.data.text).toContain(WRITE_BACK_LABEL)
      const pid = await computeProjectId({ cwd, remoteUrl: undefined })
      const projectLog = await h.store.logRead({ scope: 'project', pid, date: isoDate() })
      expect(projectLog.ok && projectLog.data.text).toContain(`delegate runner "echoFile" job ${jobId}`)

      const pending = await h.store.listPending({})
      const items = pending.ok ? pending.data : []
      expect(items).toHaveLength(1)
      expect(items[0]?.kind).toBe('memory')
      expect(String(items[0]?.proposal.content)).toContain('delegate runner "echoFile"')
      // the proposal is queued — it never entered live memory
      const live = await h.store.listEntries({ track: 'global', limit: 10 })
      expect((live.ok ? live.data.entries : []).length).toBe(0)

      const messages = await h.store.readMessages(roomId, {})
      const posted = (messages.ok ? messages.data : []).find(m => m.jobId === jobId)
      expect(posted?.text).toContain(WRITE_BACK_LABEL)
      expect(posted?.fromKind).toBe('system')

      const st = await callTool(h, 'cortex_delegate_status', { jobId })
      expect((st.job as { status: string }).status).toBe('succeeded')
      const all = await callTool(h, 'cortex_delegate_status', {})
      expect((all.jobs as unknown[]).length).toBe(1)
      const logsTool = await callTool(h, 'cortex_delegate_logs', { jobId, tailBytes: 4096 })
      expect(String(logsTool.stdout)).toContain('dsh-cortex-m6-fixture')
      const resTool = await callTool(h, 'cortex_delegate_result', { jobId })
      expect(String(resTool.result)).toContain(RESULT_HEADER)
    } finally {
      await teardown(h)
    }
  })

  it('in-root image is copied beside the job and listed in task.md', async () => {
    const h = await boot({})
    try {
      const pngPath = join(h.root, 'user-shot.png')
      await writeTextAtomic(pngPath, 'fake-png-bytes')
      const out = await callTool(h, 'cortex_delegate', { runner: 'echoFile', task: 'look at this', images: [pngPath] })
      const jobId = String((out.job as { id: string }).id)
      const done = await until('image job succeeded', async () => {
        const job = await h.svc.getJob(jobId)
        return job?.status === 'succeeded' ? job : null
      })
      expect(done).toBeTruthy()
      const copy = join(h.store.jobPaths(jobId).dir, 'images', '0-user-shot.png')
      expect(await sizeOf(copy)).toBeGreaterThan(0)
      const taskMd = (await readTextSafe(join(h.store.jobPaths(jobId).dir, 'task.md'))) ?? ''
      expect(taskMd).toContain('## attached images')
      expect(taskMd).toContain(copy)
    } finally {
      await teardown(h)
    }
  })

  it('per-stream cap: stdout.log stays under delegation.outputCapBytes, head dropped, tail kept', async () => {
    const h = await boot({ outputCapBytes: 20048 })
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'spam', task: 'flood' })
      const jobId = String((out.job as { id: string }).id)
      await until('spam job succeeded', async () => (await h.svc.getJob(jobId))?.status === 'succeeded' ? true : null)
      const size = await sizeOf(h.store.jobPaths(jobId).stdout)
      expect(size, 'stdout.log written').not.toBeNull()
      expect(size ?? 0).toBeLessThanOrEqual(20048)
      const tail = await h.svc.tail('stdout', jobId, 65536)
      expect(tail.text).toContain('head dropped') // write-side cap marker persisted
      expect(tail.text).toContain('SPAM-DONE 300kb')
      expect(tail.truncated).toBe(false) // the whole capped file fits a 64KiB read
      const small = await h.svc.tail('stdout', jobId, 1024)
      expect(small.truncated).toBe(true) // a smaller tail read is honestly flagged
    } finally {
      await teardown(h)
    }
  })

  it('timeout: killed tree, status timeout, process dead, no write-back', async () => {
    const h = await boot({})
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'sleep10', task: 'take your time' })
      const jobId = String((out.job as { id: string }).id)
      const job = await until('timeout settled with result.md', async () => {
        const j = await h.svc.getJob(jobId)
        if (j?.status !== 'timeout') return null
        return (await h.svc.readResultFile(jobId)) !== null ? j : null
      })
      expect(job.error).toContain('timed out')
      expect(processDead(job.pid), 'killed process is really gone').toBe(true)
      const result = (await h.svc.readResultFile(jobId)) ?? ''
      expect(result).toContain('— timeout')
      expect(result).toContain('skipped: the job did not succeed')
      const pendingAfterTimeout = await h.store.listPending({})
      expect(pendingAfterTimeout.ok ? pendingAfterTimeout.data.length : 1).toBe(0)
    } finally {
      await teardown(h)
    }
  })

  it('maxConcurrent=1: second dispatch refused, cancel frees the slot, third gets in', async () => {
    const h = await boot({ maxConcurrent: 1, jobTimeoutSec: 60 })
    try {
      const a = await callTool(h, 'cortex_delegate', { runner: 'sleepLong', task: 'first' })
      expect(a.status).toBe('dispatched')
      const b = await callTool(h, 'cortex_delegate', { runner: 'sleepLong', task: 'second' })
      expect(String(b.message)).toMatch(/at capacity: 1 of 1/)
      const cancel = await callTool(h, 'cortex_delegate_cancel', { jobId: (a.job as { id: string }).id })
      expect(String(cancel.message)).toContain('killed')
      await until('slot freed', async () => ((await h.svc.liveCount()) === 0 ? true : null))
      const c = await callTool(h, 'cortex_delegate', { runner: 'sleepLong', task: 'third' })
      expect(c.status).toBe('dispatched')
      await callTool(h, 'cortex_delegate_cancel', { jobId: (c.job as { id: string }).id })
      await until('c killed', async () => (await h.svc.getJob(String((c.job as { id: string }).id)))?.status === 'killed' ? true : null)
    } finally {
      await teardown(h)
    }
  })

  it('orphan recovery: a second apply() marks pre-existing running jobs lost and logs it', async () => {
    const h = await boot({})
    try {
      const created = await h.store.createJob({ runner: 'echoAppend', argv: ['x'], task: 'orphan me' })
      const jobId = created.ok ? created.data.id : ''
      expect(created.ok).toBe(true)
      await h.store.updateJob(jobId, { status: 'running', pid: String(process.pid) } satisfies Partial<Job>)

      // simulate a host restart: fresh module instance over the SAME state root
      const second = makeHarness({ delegation: delegation({ runners: RUNNERS }) }, h.root)
      delegate.apply(second.deps)
      const svc2 = delegate.getDelegateService()
      const lost = await until('orphan marked lost', async () => {
        const j = await h.svc.getJob(jobId)
        return j && j.status === ('lost' as Job['status']) ? j : null
      })
      expect(lost.error).toContain('orphaned by a host restart')
      expect(second.warnings.join('\n')).toContain('marked lost')
      expect(svc2?.activeIds()).toEqual([])
    } finally {
      await teardown(h)
    }
  })

  it('RPC endpoint maps answer jobs.* with the envelope (never throw), after bind', async () => {
    const h = await boot({})
    try {
      const listed = await delegate.readEndpoints['jobs.list']?.({ limit: 5 })
      expect(listed?.ok).toBe(true)
      expect(Array.isArray((listed as { value: unknown }).value)).toBe(true)
      const ghost = await delegate.writeEndpoints['jobs.cancel']?.({ jobId: 'ghost' })
      expect(ghost?.ok).toBe(false)
      // The code the host carries is `bad-request`; which of ours it was stays
      // readable in the message (src/host/rpc-error.ts).
      if (ghost && !ghost.ok) {
        expect(ghost.error.code).toBe('command-error')
        expect(ghost.error.message).toMatch(/\[(not-found|refused)\]/)
      }
      const out = await callTool(h, 'cortex_delegate', { runner: 'echoAppend', task: 'for rpc' })
      const jobId = String((out.job as { id: string }).id)
      await until('rpc job succeeded with result', async () => {
        const j = await h.svc.getJob(jobId)
        return j?.status === 'succeeded' && (await h.svc.readResultFile(jobId)) !== null ? true : null
      })
      const got = await delegate.readEndpoints['jobs.get']?.({ jobId })
      expect(got?.ok).toBe(true)
      const logs = await delegate.readEndpoints['jobs.logs']?.({ jobId, tailBytes: 512 })
      expect(logs?.ok).toBe(true)
      const res = await delegate.readEndpoints['jobs.result']?.({ jobId })
      expect(res?.ok).toBe(true)
      // jobs.retry now only accepts dead-letter or failed jobs (not succeeded)
      const badRetry = await delegate.writeEndpoints['jobs.retry']?.({ jobId })
      expect(badRetry?.ok).toBe(false)
      // Create a dead-letter job manually to test retry
      const dlJob = await h.store.createJob({ runner: 'echoAppend', argv: ['x'], task: 'dead letter me' })
      const dlJobId = dlJob.ok ? dlJob.data.id : ''
      expect(dlJob.ok).toBe(true)
      await h.store.updateJob(dlJobId, { status: 'dead-letter' as Job['status'] } satisfies Partial<Job>)
      const retry = await delegate.writeEndpoints['jobs.retry']?.({ jobId: dlJobId })
      expect(retry?.ok).toBe(true)
      const newId = String((retry as { value: { newJobId: string } }).value.newJobId)
      await until('retry job settled', async () => {
        const j = await h.svc.getJob(newId)
        return j?.status === 'succeeded' ? true : null
      })
      const bad = await delegate.readEndpoints['jobs.get']?.({ jobId: '../escape' })
      expect(bad?.ok).toBe(false)
    } finally {
      await teardown(h)
    }
  })
})

describe('delegate · auto-retry + dead-letter', () => {
  it('maxRetries=3: failed job auto-retries 3 times then moves to dead-letter', async () => {
    const h = await boot({ retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200 } })
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'failAlways', task: 'intentional fail' })
      expect(out.status).toBe('dispatched')
      const jobId = String((out.job as { id: string }).id)
      // Wait for all retries to exhaust: 1 initial + 3 retries = 4 runs, each ~instant (fail runner exits immediately)
      // Total time: 3 backoff waits at 50ms + 100ms + 200ms = ~350ms + process time
      await until('job moves to dead-letter', async () => {
        const j = await h.svc.getJob(jobId)
        return j?.status === 'dead-letter' ? j : null
      }, 5000)
      const job = await h.svc.getJob(jobId)
      expect(job?.status).toBe('dead-letter')
      expect(job?.retryCount).toBe(3)
      expect(job?.error).toContain('exit code 1')
    } finally {
      await teardown(h)
    }
  })

  it('maxRetries=0 (default): no auto-retry, stays failed', async () => {
    const h = await boot({})
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'failAlways', task: 'no retry' })
      const jobId = String((out.job as { id: string }).id)
      await until('job settled', async () => {
        const j = await h.svc.getJob(jobId)
        return j?.status === 'failed' || j?.status === 'dead-letter' ? j : null
      }, 5000)
      const job = await h.svc.getJob(jobId)
      expect(job?.status).toBe('failed')
      expect(job?.retryCount).toBeUndefined()
    } finally {
      await teardown(h)
    }
  })

  it('cancel during retry backoff stops the retry', async () => {
    const h = await boot({ retry: { maxRetries: 3, baseDelayMs: 5000, maxDelayMs: 60000 } })
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'failAlways', task: 'cancel mid-retry' })
      const jobId = String((out.job as { id: string }).id)
      // Wait for first attempt to fail and schedule retry
      await until('first attempt failed, retry scheduled', async () => {
        const j = await h.svc.getJob(jobId)
        return j?.status === 'queued' && (j.retryCount ?? 0) > 0 ? j : null
      }, 5000)
      expect(h.svc.retryingIds()).toContain(jobId)
      // Cancel during backoff
      const cancelResult = await h.svc.cancel(jobId)
      expect(cancelResult.ok).toBe(true)
      expect(h.svc.retryingIds()).not.toContain(jobId)
      const job = await h.svc.getJob(jobId)
      expect(job?.status).toBe('killed')
    } finally {
      await teardown(h)
    }
  })

  it('manual retry of dead-letter creates a new job', async () => {
    const h = await boot({ retry: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 200 } })
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'failAlways', task: 'die then retry' })
      const jobId = String((out.job as { id: string }).id)
      await until('job dead-letter', async () => {
        const j = await h.svc.getJob(jobId)
        return j?.status === 'dead-letter' ? j : null
      }, 5000)
      // Now manually retry — should create a NEW job
      const retryResult = await callTool(h, 'cortex_delegate_retry', { jobId })
      expect(retryResult.status).toBe('ok')
      const newJobId = String((retryResult.job as { id: string }).id)
      expect(newJobId).not.toBe(jobId)
      // The new job is the echo runner (we can't use failAlways here because it'll just die again)
      // Instead verify the original is still dead-letter
      const original = await h.svc.getJob(jobId)
      expect(original?.status).toBe('dead-letter')
    } finally {
      await teardown(h)
    }
  })

  it('succeeded job cannot be retried via manual retry', async () => {
    const h = await boot({})
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'echoAppend', task: 'succeeds' })
      const jobId = String((out.job as { id: string }).id)
      await until('job succeeded', async () => {
        const j = await h.svc.getJob(jobId)
        return j?.status === 'succeeded' ? j : null
      }, 5000)
      const retryResult = await callTool(h, 'cortex_delegate_retry', { jobId })
      expect(retryResult.status).toBe('refused')
      expect(String(retryResult.message)).toContain('only dead-letter')
    } finally {
      await teardown(h)
    }
  })

  it('retry info is exposed in viewOf and RPC jobs.list', async () => {
    const h = await boot({ retry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 200 } })
    try {
      const out = await callTool(h, 'cortex_delegate', { runner: 'failAlways', task: 'view test' })
      const jobId = String((out.job as { id: string }).id)
      // Check view has retry fields
      const job = await h.svc.getJob(jobId)
      expect(job?.maxRetries).toBe(2)
      expect(job?.retryCount).toBe(0)
      // Check RPC endpoint includes retry fields
      const rpcList = await delegate.readEndpoints['jobs.list']?.({ limit: 5 })
      expect(rpcList?.ok).toBe(true)
      const jobs = (rpcList as { value: Array<{ id: string; maxRetries?: number }> }).value
      const listed = jobs.find(j => j.id === jobId)
      expect(listed?.maxRetries).toBe(2)
    } finally {
      await teardown(h)
    }
  })
})
