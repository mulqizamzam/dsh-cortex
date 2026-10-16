/**
 * A job whose `result.md` cannot be written must NOT be given a disposition.
 *
 * `finalize` writes result.md first and job.json's terminal status second, and
 * its own comment states the invariant: "result.md always lands BEFORE job.json
 * goes terminal, so no reader can ever observe `dead-letter` (or `succeeded`)
 * in job.json next to a result.md that is missing a section" (DESIGN §4 /
 * DESIGN.md:140, result.md WAJIB konsisten dengan job.json).
 *
 * Both result.md writes sat inside `try { ... } catch { warn }`, so a failing
 * write was reported and then execution carried on into the unconditional
 * terminal patch. Any real write failure — ENOSPC, EACCES, a read-only state
 * root — produced a job.json claiming a finished disposition with no artifact
 * to back it. The existing race test only asserts call ORDER against a write
 * that always succeeds, so it cannot see this.
 *
 * The reproduction is a real filesystem error, not a patched seam: result.md is
 * created as a DIRECTORY, so the atomic rename onto it fails.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'
import { DelegateService } from '../../src/host/modules/delegate/service.ts'
import type { DelegateJob } from '../../src/host/modules/delegate/types.ts'

let root = ''

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

function makeService(): DelegateService {
  const cfg = resolveConfig({ ...DEFAULT_CONFIG, delegation: { ...DEFAULT_CONFIG.delegation, enabled: true } })
  const store = new CortexStore({ root, caps: () => cfg.caps })
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

/** Statuses that claim the job reached a disposition, i.e. that result.md exists. */
const DISPOSITIONS = ['succeeded', 'failed', 'dead-letter', 'killed', 'timeout']

describe('a job never claims a disposition without its result.md', () => {
  it('does not go terminal when the result.md write fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-finalize-'))
    const svc = makeService()
    const store = (svc as unknown as { deps: { store: CortexStore } }).deps.store
    await store.init()

    const created = await store.createJob({ runner: 'x', argv: ['/bin/true'], task: 'artifact contract' })
    if (created.ok !== true) throw new Error(created.error)
    const job = created.data as unknown as DelegateJob

    // A real, un-writable destination: rename() onto a directory fails.
    await mkdir(store.jobPaths(job.id).result, { recursive: true })

    await svc.finalize(job, { status: 'failed', exitCode: 1 })

    const listed = await store.listJobs()
    if (listed.ok !== true) throw new Error(listed.error)
    const settled = listed.data.find(candidate => candidate.id === job.id)
    if (settled === undefined) throw new Error('the job vanished')

    // The invariant: no disposition while the artifact is unwritable.
    expect(DISPOSITIONS).not.toContain(settled.status)
  })
})
