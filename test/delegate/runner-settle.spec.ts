/**
 * M5b race (b) — settle must settle the WHOLE in-flight chain.
 *
 * Race (b) from test/m5-finalize-allocation.spec.ts:4-8 (audit
 * .dev/audit-2026-10-02.md §8): `settle()` calls flushAll() -> flush(true),
 * but a flush already in flight has already cleared `dirty`, so the settle
 * flush can resolve while a NEWER write (started by another flush that
 * awaited the same in-flight write) is still running — and `finalize` then
 * composes result.md from a stdout file that does not contain the last
 * bytes.
 *
 * The earlier fix (m5c-races.spec.ts "Race B") closed the single-in-flight
 * case: flush awaits the write that was running when it was called. It left
 * the chained case open, which is what this file locks down:
 *
 *   pump A starts write W1 (blocked)     -> inflight = W1, dirty = false
 *   push 'beta'                          -> dirty = true
 *   pump B flush(false) awaits W1        -> registered before settle
 *   settle flush(true) awaits W1         -> registered after pump B
 *   W1 lands, pump B resumes FIRST       -> throttle passes, starts W2
 *   settle resumes                       -> dirty is false (B cleared it)
 *
 * Old code: settle returns right there, while W2 is still running.
 * Fixed code: settle re-reads `inflight`, awaits W2, and only then resolves.
 *
 * Deterministic barrier — gates inside persist, fake Date for the throttle,
 * no sleeps, no timing windows.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamSink } from '../../src/host/modules/delegate/runner.ts'

let root = ''

afterEach(() => {
  vi.useRealTimers()
})

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

async function fileText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

/** Let every queued microtask and immediate run before asserting. */
async function drain(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('M5b race (b): flush(true) resolves only after every in-flight write', () => {
  it('waits for a write started by another flush while it was waiting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = 10_000_000
    vi.setSystemTime(t0)
    root = await mkdtemp(join(tmpdir(), 'm5b-settle-'))
    const file = join(root, 'stdout.log')

    // Write #1 and write #2 each block on their own gate; every write lands
    // only when its gate opens, so "in flight" is exact, never timing-based.
    let openFirst: (() => void) | undefined
    let openSecond: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => { openFirst = resolve })
    const secondGate = new Promise<void>(resolve => { openSecond = resolve })
    let calls = 0
    const persist = async (_path: string, text: string): Promise<{ ok: boolean; error?: string }> => {
      calls += 1
      if (calls === 1) await firstGate
      if (calls === 2) await secondGate
      await writeFile(file, text, 'utf8')
      return { ok: true }
    }

    const sink = new StreamSink(file, 4096, persist, 50)

    sink.push('alpha')
    const pumpA = sink.flush(false) // starts write #1, blocked in firstGate
    expect(calls, 'write #1 is in flight').toBe(1)

    sink.push('beta') // dirty = true while #1 is still running
    const pumpB = sink.flush(false) // waits for #1; registered before settle
    const settle = sink.flush(true) // the flushAll() call from runProcess.settle()
    expect(calls, 'both callers wait for write #1; nobody starts a second write yet').toBe(1)

    // Write #1 lands; 100 ms of fake Date passes so pump B's throttle lets it
    // start write #2 — which is where the old code lost the settle flush.
    openFirst!()
    await pumpA
    vi.setSystemTime(t0 + 100)
    await drain()

    expect(calls, 'pump B started write #2 while settle was waiting').toBe(2)
    expect(await fileText(file), 'write #1 landed').toBe('alpha')

    let settleDone = false
    void settle.then(() => { settleDone = true })
    await drain()
    expect(settleDone, 'settle must NOT resolve while write #2 is still running').toBe(false)

    // The invariant: once settle resolves, every byte pushed before it is on disk.
    openSecond!()
    await settle
    expect(await fileText(file), 'after flush(true) every pushed byte must be on disk').toBe('alphabeta')
    expect(calls).toBe(2)
  })

  it('drains a push that arrives during its own write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000_000)
    root = await mkdtemp(join(tmpdir(), 'm5b-drain-'))
    const file = join(root, 'stdout.log')

    let openFirst: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => { openFirst = resolve })
    let calls = 0
    const persist = async (_path: string, text: string): Promise<{ ok: boolean; error?: string }> => {
      calls += 1
      if (calls === 1) await firstGate
      await writeFile(file, text, 'utf8')
      return { ok: true }
    }

    const sink = new StreamSink(file, 4096, persist, 50)
    sink.push('alpha')
    const settle = sink.flush(true) // takes the fast path: no write in flight
    expect(calls).toBe(1)
    sink.push('gamma') // arrives while settle's own write #1 is blocked

    openFirst!()
    await settle
    expect(calls, 'a forced flush must drain the buffer it left dirty').toBe(2)
    expect(await fileText(file)).toBe('alphagamma')
  })
})
