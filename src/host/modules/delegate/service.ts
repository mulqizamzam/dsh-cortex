/**
 * The delegation service: gate → dispatch → spawn → persist → finalize →
 * write-back. Job state lives in job.json under the state root (restart-safe);
 * the in-memory map only tracks processes THIS host instance started.
 *
 * Injection-prevention model (P7), read this once:
 *  - the runner argv comes ONLY from `cfg().delegation.runners` (validated at
 *    resolveConfig: empty argv dropped); user text never creates or edits it.
 *  - the task reaches the child two ways, per runner: substituted into a
 *    double-brace taskFile placeholder argv item as an absolute path, or
 *    appended as the LAST argv item verbatim — as ONE item, with `shell:false`
 *    a string like "-c rm" is data, not flags; it cannot split or reach a
 *    shell. `buildArgv` is the single code path either way.
 *  - everything this module hands back to a model (tool results, RPC values)
 *    passes `neutralizeDeep` at the render edge (P9/#53).
 */
import { isAbsolute, join, resolve } from 'node:path'
import { INJECT_LABEL } from '../../config.ts'
import { errorMessage } from '../../../lib/errors.ts'
import { readJsonSafe, readTextSafe } from '../../../lib/fsx.ts'
import { ensureDir } from '../../../lib/home.ts'
import { clampText, trimToBudget } from '../../../lib/caps.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { projectId as computeProjectId } from '../../../lib/pid.ts'
import { originRemote } from '../../../lib/gitx.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import type { HostAgent, RpcResult } from '../../dsh.ts'
import type { Job, JobStatus, ModuleDeps, ResolvedConfig, RunnerSpec } from '../../types.ts'
import {
  DEAD_LETTER_STATUS, IMAGE_EXTENSIONS, IMAGE_MAX_BYTES, LOST_STATUS, RESULT_HEADER, TASK_FILE_TOKEN,
  WRITE_BACK_LABEL, asJobStatus, isDeadLetter, isLiveStatus, isRetryable, viewOf,
} from './types.ts'
import type { DelegateJob, DelegateView } from './types.ts'
import { copyImage, runProcess, tailByBytes } from './runner.ts'
import type { RunningJob, RunOutcome } from './runner.ts'
import { conflictService } from '../conflict/service.ts'
import { refuse } from '../../rpc-error.ts'

export interface DispatchInput {
  runner: unknown
  task: unknown
  workdir?: unknown
  images?: unknown
  includeMemory?: unknown
  roomId?: unknown
}

export interface DispatchResult {
  ok: boolean
  /** One honest sentence: what happened, naming config keys when that's the fix. */
  message: string
  job?: DelegateView
}

const OK = (message: string, job?: DelegateView): DispatchResult => ({ ok: true, message, ...(job ? { job } : {}) })
const NO = (message: string): DispatchResult => ({ ok: false, message })

/** The store's createJob parameter type, widened additively for `projectId`
 * (a persisted field the frozen Job type predates). Passing through a typed
 * variable — not a fresh literal — keeps excess-property checks quiet. */
type CreateJobInput = Parameters<import('../../store.ts').CortexStore['createJob']>[0] & { projectId?: string }

export class DelegateService {
  private readonly deps: ModuleDeps
  private readonly active = new Map<string, RunningJob>()
  /** Pending retry timers: jobId → setTimeout handle. Cleared on cancel/shutdown. */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(deps: ModuleDeps) {
    this.deps = deps
  }

  cfg(): ResolvedConfig {
    return this.deps.cfg()
  }

  private taskFile(jobId: string): string {
    return join(this.deps.store.jobPaths(jobId).dir, 'task.md')
  }

  /** DESIGN §4 gate. One line, names the config key (P3). */
  gateRefusal(): string | null {
    if (this.cfg().delegation.enabled === true) return null
    return 'delegation is OFF: set the dsh-cortex config key delegation.enabled to true (and register runners under delegation.runners) to use it.'
  }

  runnerNames(): string[] {
    return Object.keys(this.cfg().delegation.runners)
  }

  // --------------------------------------------------------------- dispatch --
  async dispatch(input: DispatchInput, agent?: HostAgent): Promise<DispatchResult> {
    const refusal = this.gateRefusal()
    if (refusal !== null) return NO(refusal)

    const runner = typeof input.runner === 'string' ? input.runner.trim() : ''
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (runner === '') return NO('delegate needs a runner name.')
    if (task === '') return NO('delegate needs a non-empty task.')
    const spec: RunnerSpec | undefined = this.cfg().delegation.runners[runner]
    if (spec === undefined || !Array.isArray(spec.argv) || spec.argv.length === 0) {
      const known = this.runnerNames()
      return NO(`runner "${neutralize(runner)}" is not registered under delegation.runners (${known.length > 0 ? `known runners: ${known.join(', ')}` : 'the registry is empty'}).`)
    }

    // The CALLER may not choose where a child runs: an absolute `workdir`
    // argument is refused outright, so task text can never redirect execution.
    // The working directory comes from the runner's own `cwd` in config, and
    // falls back to the plugin state root when the runner declares none.
    const workdir = typeof input.workdir === 'string' ? input.workdir.trim() : ''
    if (workdir !== '' && resolve(workdir) !== resolve(this.deps.store.root)) {
      return NO('workdir cannot be set by the caller: a delegation job runs in its runner\'s configured cwd (delegation.runners.<name>.cwd), or the plugin state root when that is absent.')
    }
    const jobCwd = spec.cwd !== undefined && spec.cwd !== '' ? spec.cwd : this.deps.store.root

    if (input.images !== undefined && !Array.isArray(input.images)) return NO('images must be an array of paths under the plugin state root.')
    const imageSources: string[] = []
    for (const item of Array.isArray(input.images) ? input.images : []) {
      const checked = this.validateImage(item)
      if (checked.error !== undefined) return NO(checked.error)
      if (checked.path !== undefined) imageSources.push(checked.path)
    }

    const roomId = typeof input.roomId === 'string' ? input.roomId.trim() : ''
    if (roomId !== '') {
      if (!isSafeKey(roomId)) return NO('roomId must be a safe id ([A-Za-z0-9_-]{1,64}).')
      const room = await this.deps.store.getRoom(roomId)
      if (!room.ok || room.data === null) return NO(`room ${neutralize(roomId)} does not exist.`)
    }

    const max = this.cfg().delegation.maxConcurrent
    const page = await this.listJobs(500)
    const live = page.jobs.filter(job => isLiveStatus(job.status) || this.active.has(job.id)).length
    if (live >= max) return NO(`at capacity: ${String(live)} of ${String(max)} concurrent delegation jobs are live (delegation.maxConcurrent); retry after one finishes.`)

    const projectId = await this.resolveProjectId(agent)
    const maxRetries = this.cfg().delegation.retry.maxRetries
    const createInput: CreateJobInput = {
      runner,
      argv: spec.argv,
      task,
      cwd: jobCwd,
      ...(projectId ? { projectId } : {}),
      ...(roomId !== '' ? { roomId } : {}),
      ...(agent?.id !== undefined ? { sessionId: String(agent.id) } : {}),
      ...(maxRetries > 0 ? { maxRetries } : {}),
    }
    const created = await this.deps.store.createJob(createInput)
    if (!created.ok) return NO(`createJob failed: ${neutralize(created.error)}`)
    const job = created.data as DelegateJob
    // store.createJob assembles job.json from its declared fields only, so the
    // additive projectId goes through the updateJob spread path.
    if (projectId !== undefined) {
      job.projectId = projectId
      await this.patch(job.id, { projectId })
    }

    // Auto-declare the job's cwd as a conflict claim when room-linked. This
    // flags to other agents in the same room that a workspace is in use, so
    // they can detect overlapping file writes before starting their own work.
    // TTL set to the job's timeout window so the claim auto-cleans if the job
    // is never finalized (orphaned/corpsed path) — no schema change needed.
    let claimId: string | undefined
    if (roomId !== '') {
      try {
        const conflictSvc = conflictService(this.deps)
        const jobTimeoutSec = this.cfg().delegation.jobTimeoutSec
        const result = conflictSvc.declare({
          roomId,
          // The REAL working directory, not the state root: a claim on a path
          // the job never touches would report a conflict that cannot happen,
          // and would miss the one that can.
          path: jobCwd,
          description: `delegate job ${job.id} (runner: ${job.runner})`,
          sessionId: job.sessionId ?? '',
          ttlSeconds: jobTimeoutSec > 0 ? jobTimeoutSec : 3600,
        })
        if (result.ok && result.claim !== undefined) {
          claimId = result.claim.id
          job.conflictClaimId = claimId
          await this.patch(job.id, { conflictClaimId: claimId })
        }
      } catch (error) {
        this.deps.warn(`delegate: conflict declare failed for job ${job.id}: ${errorMessage(error)}`)
      }
    }

    try {
      await this.writeTaskFile(job, spec, imageSources, input.includeMemory === true)
    } catch (error) {
      const detail = errorMessage(error)
      // The job exists and failed honestly; finalize writes result.md and
      // leaves the trace (no write-back for failed jobs).
      await this.finalize(job, { status: 'failed', exitCode: null, error: `task file failed: ${detail}` })
      return NO(`job ${job.id} was created but could not start: ${neutralize(detail)}`)
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env }
    const timeoutSec = spec.timeoutSec > 0 ? spec.timeoutSec : this.cfg().delegation.jobTimeoutSec
    const files = this.deps.store.jobPaths(job.id)
    const handle = runProcess({
      argv: buildArgv(spec.argv, job.task ?? task, this.taskFile(job.id)),
      cwd: jobCwd,
      env,
      timeoutMs: timeoutSec * 1000,
      stdoutFile: files.stdout,
      stderrFile: files.stderr,
      capBytes: this.cfg().delegation.outputCapBytes,
      persist: (file, text) => this.deps.store.writeStateFile(file, text),
    })
    this.active.set(job.id, handle)
    await this.patch(job.id, { status: 'running', ...(handle.pid !== undefined ? { pid: String(handle.pid) } : {}) })

    // Attach AFTER the running-patch awaits: a synchronously failed spawn has
    // an already-resolved outcome, and finalize must not race the patch.
    void handle.outcome.then(
      async (outcome) => {
        this.active.delete(job.id)
        await this.finalize(job, outcome)
      },
      async (error: unknown) => {
        this.active.delete(job.id)
        await this.finalize(job, { status: 'failed', exitCode: null, error: errorMessage(error) })
      },
    )

    return OK(`job ${job.id} dispatched to runner "${neutralize(runner)}"; follow up with cortex_delegate_status / _logs / _result / _cancel.`, viewOf(job))
  }

  private validateImage(item: unknown): { path?: string; error?: string } {
    if (typeof item !== 'string' || item.trim() === '') return { error: 'images entries must be non-empty strings.' }
    const path = item.trim()
    if (!isAbsolute(path)) return { error: `image "${neutralize(path)}" must be an absolute path inside the plugin state root.` }
    const root = resolve(this.deps.store.root)
    const abs = resolve(path)
    if (abs !== root && !abs.startsWith(root + '/')) {
      return { error: `image "${neutralize(path)}" is outside the plugin state root — refused; only plugin-owned files may be handed to runners.` }
    }
    const lower = abs.toLowerCase()
    if (!IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return { error: `image "${neutralize(path)}" has an unsupported type (allowed: ${IMAGE_EXTENSIONS.join(', ')}).` }
    return { path: abs }
  }

  /** Requester project id: agent cwd → normalized origin remote or realpath
   * (pid.ts). No cwd / any failure = no project scope, reported honestly. */
  private async resolveProjectId(agent?: HostAgent): Promise<string | undefined> {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return undefined
    try {
      const remote = await originRemote(cwd)
      return await computeProjectId({ cwd, remoteUrl: remote })
    } catch (error) {
      this.deps.warn(`delegate: project id for ${neutralize(cwd)} unavailable: ${errorMessage(error)}`)
      return undefined
    }
  }

  private async writeTaskFile(job: DelegateJob, spec: RunnerSpec, imageSources: string[], includeMemory: boolean): Promise<void> {
    const imagesDir = join(this.deps.store.jobPaths(job.id).dir, 'images')
    const copied: string[] = []
    if (imageSources.length > 0) await ensureDir(imagesDir)
    for (const [index, src] of imageSources.entries()) {
      const name = src.slice(src.lastIndexOf('/') + 1) || 'image'
      copied.push(await copyImage(src, join(imagesDir, `${String(index)}-${name}`), IMAGE_MAX_BYTES))
    }
    const parts: string[] = [RESULT_HEADER, '', `runner: ${neutralize(spec.description !== '' ? spec.description : job.runner)}`, '', '## task', '', neutralize(job.task ?? '')]
    if (copied.length > 0) parts.push('', '## attached images (local files, viewable with read_image)', ...copied.map(path => `- ${path}`))
    if (includeMemory) {
      const block = await this.renderMemorySection(job.projectId)
      if (block !== '') parts.push('', '## plugin memory context', '', block)
    }
    const written = await this.deps.store.writeStateFile(this.taskFile(job.id), `${parts.join('\n')}\n`)
    if (!written.ok) throw new Error(written.error)
  }

  /** includeMemory: current store entries at the per-track budgets (P2), with
   * the honest label, neutralized. Feeds a FILE for the external runner — it
   * never enters a model turn from here. */
  private async renderMemorySection(projectId?: string): Promise<string> {
    const cfg = this.cfg()
    const store = this.deps.store
    const sections: string[] = [neutralize(INJECT_LABEL)]
    const tracks: { track: 'user' | 'global' | 'project'; budget: number }[] = [
      { track: 'user', budget: cfg.caps.userTrackChars },
      { track: 'global', budget: cfg.caps.globalTrackChars },
      ...(projectId ? [{ track: 'project' as const, budget: cfg.caps.projectTrackChars }] : []),
    ]
    for (const item of tracks) {
      const listed = await store.listEntries({ track: item.track, ...(projectId && item.track === 'project' ? { pid: projectId } : {}), limit: 200 })
      if (!listed.ok) continue
      const lines = listed.data.entries.map(entry => `- [importance ${String(entry.importance)}] ${neutralize(entry.content)}`)
      const budget = trimToBudget(lines, item.budget)
      if (budget.text !== '') sections.push(`### ${item.track}`, budget.text)
    }
    return sections.length > 1 ? sections.join('\n') : ''
  }

  // ------------------------------------------------------------------- read --
  async getJob(id: unknown): Promise<DelegateJob | null> {
    if (typeof id !== 'string' || !isSafeKey(id)) return null
    const store = this.deps.store
    return await readJsonSafe<DelegateJob | null>(store.paths.jobDoc(id), {
      fallback: null,
      quarantineDir: store.paths.quarantine(),
      warn: message => this.deps.warn(`delegate: ${message}`),
    })
  }

  async listJobs(limit = 20): Promise<{ jobs: DelegateJob[]; truncated: boolean }> {
    const listed = await this.deps.store.listJobs()
    const jobs = (listed.ok ? listed.data : []) as DelegateJob[]
    return { jobs: jobs.slice(0, limit), truncated: jobs.length > limit }
  }

  /** Jobs holding a concurrency slot right now (disk status ∪ this instance). */
  async liveCount(): Promise<number> {
    const page = await this.listJobs(500)
    return page.jobs.filter(job => isLiveStatus(job.status) || this.active.has(job.id)).length
  }

  async tail(kind: 'stdout' | 'stderr', jobId: string, tailBytes: number): Promise<{ text: string; truncated: boolean }> {
    const file = this.deps.store.jobPaths(jobId)[kind]
    const raw = (await readTextSafe(file, message => this.deps.warn(`delegate: ${message}`))) ?? ''
    return { text: tailByBytes(raw, tailBytes), truncated: Buffer.byteLength(raw, 'utf8') > Buffer.byteLength(tailByBytes(raw, tailBytes), 'utf8') }
  }

  async readResultFile(jobId: string): Promise<string | null> {
    if (!isSafeKey(jobId)) return null
    return await readTextSafe(this.deps.store.jobPaths(jobId).result, message => this.deps.warn(`delegate: ${message}`))
  }

  // ----------------------------------------------------------------- cancel --
  async cancel(id: unknown): Promise<DispatchResult> {
    const job = await this.getJob(id)
    if (job === null) return NO(`no such job: ${neutralize(String(id))}`)
    if (!isLiveStatus(job.status)) return NO(`job ${job.id} is already ${job.status}; nothing to cancel.`)
    // Check for pending retry timer (backoff wait): clear it and mark killed
    const retryTimer = this.retryTimers.get(job.id)
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      this.retryTimers.delete(job.id)
      await this.patch(job.id, { status: asJobStatus('killed'), finishedAt: new Date().toISOString(), nextRetryAt: undefined, error: 'cancelled during retry backoff' })
      return OK(`job ${job.id} retry cancelled; settled as 'killed'.`, viewOf(job))
    }
    const handle = this.active.get(job.id)
    if (handle === undefined) {
      // 'running' on disk but no process owned here: a corpse from a host
      // that restarted mid-run — same disposition as the boot sweep.
      await this.patch(job.id, { status: asJobStatus(LOST_STATUS), finishedAt: new Date().toISOString(), error: 'cancel requested, but no live process is owned by this host instance' })
      const fresh = await this.getJob(job.id)
      return OK(`job ${job.id} had no live process here — marked lost.`, fresh !== null ? viewOf(fresh) : undefined)
    }
    handle.cancel()
    return OK(`cancellation requested for job ${job.id}; it settles as 'killed'.`, viewOf(job))
  }

  // ------------------------------------------------------- lifecycle / boot --
  /** Apply-time orphan recovery (BRIEFS M6): a 'running'/'queued' job.json
   * with no process owned HERE is a corpse from a previous host — mark
   * 'lost', report the ids honestly, never resurrect or re-spawn. */
  async sweepOrphans(): Promise<string[]> {
    const lost: string[] = []
    // Clear any stale retry timers (shouldn't exist at boot, but be safe)
    for (const [jobId, timer] of this.retryTimers) {
      clearTimeout(timer)
      this.retryTimers.delete(jobId)
    }
    const listed = await this.deps.store.listJobs()
    if (!listed.ok) return lost
    for (const job of listed.data) {
      if (!isLiveStatus(job.status) || this.active.has(job.id)) continue
      await this.patch(job.id, {
        status: asJobStatus(LOST_STATUS),
        finishedAt: new Date().toISOString(),
        error: 'orphaned by a host restart; marked lost, not resumed',
        nextRetryAt: undefined,
      })
      lost.push(job.id)
    }
    if (lost.length > 0) this.deps.warn(`delegate: ${String(lost.length)} orphaned job(s) marked lost at boot: ${lost.join(', ')}`)
    return lost
  }

  private async patch(id: string, patch: Partial<DelegateJob>): Promise<void> {
    const result = await this.deps.store.updateJob(id, patch as Partial<Job>)
    if (!result.ok) this.deps.warn(`delegate: updateJob(${id}) failed: ${result.error}`)
    else if (result.data === null) this.deps.warn(`delegate: updateJob(${id}) found no job.json`)
  }

  /** Terminal disposition: result.md (always, success or not), job.json
   * status, and — on success ONLY — the write-back through store APIs. */
  async finalize(job: DelegateJob, outcome: RunOutcome): Promise<void> {
    const cfg = this.cfg()
    const files = this.deps.store.jobPaths(job.id)
    const stdoutRaw = (await readTextSafe(files.stdout, message => this.deps.warn(`delegate: ${message}`))) ?? ''
    const stderrRaw = (await readTextSafe(files.stderr, message => this.deps.warn(`delegate: ${message}`))) ?? ''
    const usedStdout = stdoutRaw.trim() !== ''
    const body = usedStdout ? stdoutRaw : stderrRaw
    const bodyTail = clampText(neutralize(tailByBytes(body, Math.max(1024, cfg.delegation.outputCapBytes))), cfg.caps.searchResultChars)
    const summary = summarize(body, outcome.error)
    const finishedAt = new Date().toISOString()
    const status = outcome.status

    // Release the auto-declared conflict claim so other agents can use the path.
    if (typeof job.conflictClaimId === 'string' && job.conflictClaimId !== '') {
      try {
        const conflictSvc = conflictService(this.deps)
        conflictSvc.release(job.conflictClaimId)
      } catch (error) {
        this.deps.warn(`delegate: conflict release failed for job ${job.id}: ${errorMessage(error)}`)
      }
    }

    // Disposition is DECIDED before result.md is composed: a job that ends in
    // the dead-letter queue must not be described as a plain `failed` one, and
    // an attempt that schedules a retry must say so. (Live evidence: job
    // 31e83e1407dc was `dead-letter` in job.json while result.md read
    // "— failed" because the header was built from the raw run outcome.)
    const retryable = isRetryable(status)
    const retryCount = job.retryCount ?? 0
    const maxRetries = job.maxRetries ?? 0
    const willRetry = retryable && maxRetries > 0 && retryCount < maxRetries
    const willDeadLetter = retryable && maxRetries > 0 && retryCount >= maxRetries
    const terminalStatus: string = willDeadLetter ? DEAD_LETTER_STATUS : status

    // Why the last attempt died, in one honest phrase. `error` is deliberately
    // cleared while a job waits in `queued`, so without persisting this the
    // entire 2/4/8s backoff read as "queued, exit —" with no reason attached.
    const failureReason = outcome.error
      ?? (status === 'timeout' ? 'timed out' : outcome.exitCode === null ? 'failed' : `exit code ${String(outcome.exitCode)}`)

    const lines = [
      `# Delegate job ${job.id} — ${terminalStatus}`,
      '',
      RESULT_HEADER,
      '',
      `- runner: ${neutralize(job.runner)}`,
      `- exit code: ${outcome.exitCode === null ? 'n/a' : String(outcome.exitCode)}${outcome.error !== undefined ? ` (${neutralize(outcome.error)})` : ''}`,
      `- started: ${job.startedAt}   finished: ${finishedAt}`,
      `- cwd: ${neutralize(job.cwd ?? this.deps.store.root)}`,
      `- attempt: ${String(retryCount + 1)} of ${String(Math.max(1, maxRetries + 1))}${maxRetries > 0 ? ` (auto-retries: ${String(retryCount)}/${String(maxRetries)})` : ' (auto-retry disabled)'}`,
      '',
      '## task',
      '',
      neutralize(job.task ?? ''),
      '',
      `## ${usedStdout ? 'stdout' : 'stderr (stdout was empty)'} — tail, capped`,
      '',
      bodyTail === '' ? '(no output)' : bodyTail,
    ]

    if (willRetry) {
      const next = retryCount + 1
      const delay = this.retryDelayMs(next)
      lines.push('', '## auto-retry', `- attempt ${String(retryCount + 1)} did not succeed; retry ${String(next)} of ${String(maxRetries)} is scheduled after ${String(delay)}ms of backoff.`)
    } else if (willDeadLetter) {
      lines.push('', '## dead-letter', `- this job used all ${String(maxRetries)} automatic retries without succeeding. It is parked in the dead-letter queue for a human decision; re-dispatch it from the Cortex panel (Jobs tab) or with cortex_delegate_retry.`)
    }

    // Terminal status FIRST: job.json must be authoritative before any
    // side-effecting write-back runs, so a crash mid-write-back can never
    // leave a 'running' corpse behind a completed job.
    await this.patch(job.id, {
      status: terminalStatus as JobStatus,
      exitCode: outcome.exitCode,
      finishedAt,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      // A success clears the stale failure reason; anything else records it.
      ...(status === 'succeeded' ? { lastError: undefined } : { lastError: failureReason }),
    })

    if (status === 'succeeded') {
      const notes = await this.writeBack({ ...job, finishedAt, exitCode: outcome.exitCode }, summary)
      lines.push('', '## write-back', ...notes.map(note => `- ${note}`))
    } else {
      lines.push('', '## write-back', `- skipped: the job did not succeed (${terminalStatus}). Streams and this result stay on disk.`)
    }

    try {
      const written = await this.deps.store.writeStateFile(files.result, `${lines.join('\n')}\n`)
      if (!written.ok) throw new Error(written.error)
    } catch (error) {
      this.deps.warn(`delegate: result.md write failed for ${job.id}: ${errorMessage(error)}`)
    }

    // --- auto-retry + dead-letter scheduling ---
    if (willRetry) {
      const nextCount = retryCount + 1
      const delay = this.retryDelayMs(nextCount)
      const nextRetryAt = new Date(Date.now() + delay).toISOString()
      await this.patch(job.id, {
        retryCount: nextCount,
        nextRetryAt,
        // Keep status as queued so the job stays visible and occupies a concurrency slot
        // during the backoff window. sweepOrphans at boot will mark it lost if the
        // host restarts during backoff (honest: the timer died with the host).
        status: asJobStatus('queued'),
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        exitCode: undefined,
        error: undefined,
        // `error` is cleared above, so re-assert the reason here: this is the
        // only place it is visible during the backoff wait.
        lastError: failureReason,
      })
      this.deps.log(`delegate: job ${job.id} retry ${nextCount}/${String(maxRetries)} scheduled in ${String(delay)}ms`)
      this.scheduleRetry(job.id, delay)
    } else if (willDeadLetter) {
      this.deps.log(`delegate: job ${job.id} moved to dead-letter (exhausted ${String(maxRetries)} retries)`)
    } else {
      this.deps.log(`delegate: job ${job.id} ${terminalStatus} (exit ${String(outcome.exitCode)})`)
    }
  }

  // ------------------------------------------------------------ write-back --
  /** WRITE-BACK (DESIGN §4): always on when the job succeeded — labelled
   * project + daily log lines, a PENDING memory proposal (the queue, never a
   * direct entry; `origin: import` is stamped when the proposal is approved),
   * and a room post when the job is room-linked. Every failure becomes an
   * honest note line that finalize appends to result.md. */
  async writeBack(job: DelegateJob, summary: string): Promise<string[]> {
    const notes: string[] = []
    const cfg = this.cfg()
    const store = this.deps.store
    const label = neutralize(WRITE_BACK_LABEL)
    const line = clampText(`${label} delegate runner "${job.runner}" job ${job.id} succeeded: ${summary}`, cfg.caps.logLineChars)

    if (typeof job.projectId === 'string' && job.projectId !== '') {
      const appended = await store.logAppend({ scope: 'project', pid: job.projectId, text: line })
      notes.push(appended.ok ? 'project log: appended' : `project log FAILED: ${neutralize(appended.error)}`)
    } else {
      notes.push('project log: skipped (the requester session had no project scope)')
    }

    const daily = await store.logAppend({ scope: 'daily', text: line })
    notes.push(daily.ok ? 'daily log: appended' : `daily log FAILED: ${neutralize(daily.error)}`)

    const proposal = clampText(`External run via delegate runner "${job.runner}" (job ${job.id}): ${summary}`, cfg.caps.entryChars)
    const pending = await store.addPending({
      kind: 'memory',
      proposal: { track: 'global', content: proposal, importance: 3, tags: ['delegation', job.runner] },
      reason: `machine-authored write-back from job ${job.id} — confirm before keeping`,
      ...(job.sessionId !== undefined ? { fromSessionId: job.sessionId } : {}),
    })
    notes.push(pending.ok ? `memory proposal: queued as pending ${pending.data.id}` : `memory proposal FAILED: ${neutralize(pending.error)}`)

    if (typeof job.roomId === 'string' && job.roomId !== '') {
      const posted = await store.postMessage(job.roomId, {
        text: clampText(`${label} job ${job.id} (runner ${job.runner}) finished: ${summary}`, cfg.caps.logLineChars * 2),
        fromKind: 'system',
        fromLabel: 'delegate',
        jobId: job.id,
      })
      notes.push(posted.ok && posted.data !== null ? `room ${job.roomId}: message ${String(posted.data.seq)} posted` : `room post FAILED: ${neutralize(posted.ok ? 'room vanished mid-write-back' : posted.error)}`)
    }

    return notes
  }

  /** Test/diagnostic helper: job ids this instance owns a live process for. */
  activeIds(): string[] {
    return [...this.active.keys()]
  }

  /** Job ids with pending retry timers (backoff wait). */
  retryingIds(): string[] {
    return [...this.retryTimers.keys()]
  }

  // ------------------------------------------------------- auto-retry --
  /** Exponential backoff with cap: base * 2^(attempt-1), clamped to maxDelayMs. */
  private retryDelayMs(attempt: number): number {
    const { baseDelayMs, maxDelayMs } = this.cfg().delegation.retry
    const delay = baseDelayMs * Math.pow(2, attempt - 1)
    return Math.min(delay, maxDelayMs)
  }

  /** Schedule a retry for a job after the backoff delay. */
  private scheduleRetry(jobId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId)
      void this.runRetry(jobId)
    }, delayMs)
    timer.unref?.()
    this.retryTimers.set(jobId, timer)
  }

  /** Execute a scheduled retry: re-read job from disk, re-dispatch process. */
  private async runRetry(jobId: string): Promise<void> {
    const job = await this.getJob(jobId)
    if (job === null) {
      this.deps.warn(`delegate: retry for ${jobId} — job.json not found, aborting`)
      return
    }
    // Safety: only retry queued jobs with a retryCount > 0
    if (job.status !== ('queued' as JobStatus) || (job.retryCount ?? 0) <= 0) {
      this.deps.warn(`delegate: retry for ${jobId} — status ${job.status} or no retryCount, aborting`)
      return
    }
    const spec = this.cfg().delegation.runners[job.runner]
    if (spec === undefined || !Array.isArray(spec.argv) || spec.argv.length === 0) {
      // Runner removed from config: move to dead-letter
      await this.patch(job.id, {
        status: asJobStatus(DEAD_LETTER_STATUS),
        finishedAt: new Date().toISOString(),
        error: `runner "${job.runner}" is no longer registered under delegation.runners`,
        nextRetryAt: undefined,
      })
      this.deps.warn(`delegate: job ${jobId} runner removed — moved to dead-letter`)
      return
    }

    const timeoutSec = spec.timeoutSec > 0 ? spec.timeoutSec : this.cfg().delegation.jobTimeoutSec
    const files = this.deps.store.jobPaths(job.id)
    // The retry runs where attempt 1 ran. Dispatch resolves the runner's
    // configured `cwd` into `job.cwd` (falling back to the state root), so a
    // retry that hardcoded the state root would silently move the work:
    // `job.json` and result.md both record `job.cwd`, the conflict claim was
    // declared on it, and a retry writing somewhere else lands in a directory
    // nothing claimed.
    const retryCwd = job.cwd !== undefined && job.cwd !== '' ? job.cwd : this.deps.store.root
    const handle = runProcess({
      argv: buildArgv(spec.argv, job.task ?? '', this.taskFile(job.id)),
      cwd: retryCwd,
      env: { ...process.env, ...spec.env },
      timeoutMs: timeoutSec * 1000,
      stdoutFile: files.stdout,
      stderrFile: files.stderr,
      capBytes: this.cfg().delegation.outputCapBytes,
      persist: (file, text) => this.deps.store.writeStateFile(file, text),
    })
    this.active.set(job.id, handle)
    await this.patch(job.id, {
      status: 'running',
      nextRetryAt: undefined,
      startedAt: new Date().toISOString(),
      ...(handle.pid !== undefined ? { pid: String(handle.pid) } : {}),
    })

    void handle.outcome.then(
      async (outcome) => {
        this.active.delete(job.id)
        await this.finalize(job, outcome)
      },
      async (error: unknown) => {
        this.active.delete(job.id)
        await this.finalize(job, { status: 'failed', exitCode: null, error: errorMessage(error) })
      },
    )
  }

  // ----------------------------------------------------------------- manual retry --
  /** Manually retry a dead-letter or failed job: creates a NEW job with the same
   * runner/task, resetting retryCount to 0 (fresh chain). The original stays as evidence. */
  async retryJob(id: unknown): Promise<DispatchResult> {
    const job = await this.getJob(id)
    if (job === null) return NO(`no such job: ${neutralize(String(id))}`)
    if (!isDeadLetter(job.status) && job.status !== 'failed' && job.status !== 'timeout') {
      return NO(`job ${job.id} is ${job.status}; only dead-letter, failed, or timeout jobs can be retried.`)
    }
    if (!this.runnerNames().includes(job.runner)) {
      return NO(`runner "${job.runner}" is no longer registered under delegation.runners.`)
    }
    return this.dispatch({ runner: job.runner, task: job.task })
  }
}

/** First meaningful output line (skip the sink's own cap marker), fallback to
 * the error text, then '(no output)' — never the whole tail (P2). */
export function summarize(output: string, error?: string): string {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  const first = lines.find(line => !line.startsWith('[…')) ?? lines[0]
  return clampText(neutralize(first ?? error ?? '(no output)'), 240)
}

/**
 * P7 argv build — the only task-text path into the child:
 *   - every argv item equal to the double-brace taskFile token is replaced by
 *     the absolute task.md path (the runner reads the task from the FILE);
 *   - with no placeholder, the task is appended as ONE final argv item.
 * All other items pass through untouched; nothing tokenizes, quotes or shells.
 */
export function buildArgv(specArgv: readonly string[], task: string, taskFilePath: string): string[] {
  const hasPlaceholder = specArgv.some(item => item === TASK_FILE_TOKEN)
  const mapped = specArgv.map(item => (item === TASK_FILE_TOKEN ? taskFilePath : item))
  return hasPlaceholder ? mapped : [...mapped, task]
}

// --------------------------------------------------------------------- RPC --
/** Frozen `.dev/RPC-ENDPOINTS.md` names: jobs.list, jobs.logs (read) +
 * jobs.cancel, jobs.retry (write); `jobs.get` and `jobs.result` are M6
 * additions for the parent to append to that file at integration. */
export type EndpointHandler = (payload: unknown) => Promise<RpcResult<unknown>> | RpcResult<unknown>

const asNope = (message: string, code = 'refused'): RpcResult<unknown> =>
  refuse(neutralize(message), code)

export function delegateEndpoints(svc: DelegateService): { read: Record<string, EndpointHandler>; write: Record<string, EndpointHandler> } {
  const read: Record<string, EndpointHandler> = {
    'jobs.list': async (payload) => {
      const raw = (payload ?? {}) as { limit?: unknown }
      const limit = typeof raw.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(raw.limit))) : 50
      const page = await svc.listJobs(limit)
      return {
        ok: true,
        value: neutralizeDeep(page.jobs.map(job => {
          const view = viewOf(job)
          return {
            id: view.id, runner: view.runner, status: view.status,
            startedAt: view.startedAt, finishedAt: view.finishedAt, exitCode: view.exitCode,
            summaryChars: view.taskChars,
            ...(view.error !== undefined ? { error: view.error } : {}),
            ...(view.lastError !== undefined ? { lastError: view.lastError } : {}),
            ...(view.retryCount !== undefined ? { retryCount: view.retryCount } : {}),
            ...(view.maxRetries !== undefined ? { maxRetries: view.maxRetries } : {}),
            ...(view.nextRetryAt !== undefined ? { nextRetryAt: view.nextRetryAt } : {}),
          }
        })),
      }
    },
    'jobs.get': async (payload) => {
      const id = (payload ?? {}) as { jobId?: unknown }
      const job = await svc.getJob(id.jobId)
      return job === null ? asNope('no such job', 'not-found') : { ok: true, value: neutralizeDeep(viewOf(job)) }
    },
    'jobs.logs': async (payload) => {
      const p = (payload ?? {}) as { jobId?: unknown; tailBytes?: unknown }
      if (typeof p.jobId !== 'string' || !isSafeKey(p.jobId)) return asNope('jobId must be a safe id')
      const tailBytes = typeof p.tailBytes === 'number' ? Math.min(65536, Math.max(256, Math.floor(p.tailBytes))) : 8192
      const stdout = await svc.tail('stdout', p.jobId, tailBytes)
      const stderr = await svc.tail('stderr', p.jobId, tailBytes)
      return { ok: true, value: neutralizeDeep({ stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated }) }
    },
    'jobs.result': async (payload) => {
      const p = (payload ?? {}) as { jobId?: unknown }
      if (typeof p.jobId !== 'string' || !isSafeKey(p.jobId)) return asNope('jobId must be a safe id')
      const text = await svc.readResultFile(p.jobId)
      return text === null ? asNope('no result written yet', 'not-found') : { ok: true, value: neutralizeDeep({ text: clampText(text, svc.cfg().caps.searchResultChars) }) }
    },
  }
  const write: Record<string, EndpointHandler> = {
    'jobs.cancel': async (payload) => {
      const id = (payload ?? {}) as { jobId?: unknown }
      const result = await svc.cancel(id.jobId)
      return result.ok ? { ok: true, value: neutralizeDeep({ message: result.message }) } : asNope(result.message, 'refused')
    },
    'jobs.retry': async (payload) => {
      const id = (payload ?? {}) as { jobId?: unknown }
      const result = await svc.retryJob(id.jobId)
      return result.ok && result.job !== undefined
        ? { ok: true, value: neutralizeDeep({ newJobId: result.job.id }) }
        : asNope(result.message, 'refused')
    },
  }
  return { read, write }
}
