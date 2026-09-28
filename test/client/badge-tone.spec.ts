// @vitest-environment node
/**
 * Badge tone + retry-reason visibility in the Jobs tab.
 *
 * Both tests here are regression guards for defects that shipped silently:
 *
 *  1. The bundle ships no stylesheet, so `cx-badge-<tone>` matched no rule
 *     anywhere. Live measurement in the running GUI confirmed every tone
 *     (plain/ok/warn/danger) computed to identical styles — the Jobs tab gave
 *     no visual signal at all, and a dead-letter row was indistinguishable from
 *     a succeeded one.
 *  2. `error` is cleared while a job waits in `queued`, and the `failed`
 *     transition lasts under a millisecond — so during the whole 2/4/8s
 *     backoff the UI could show "queued, exit —" with no reason anywhere.
 *     `lastError` is the field that survives that window.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async () => {
  const { reactHarness } = await import('./harness.ts')
  return { ...reactHarness, default: reactHarness }
})

const { installGlobals, mount, settle, createNode, MiniEvent } = await import('./harness.ts')
const { createCortexApi } = await import('../../src/client/api.ts')
const { createMockTransport } = await import('../../src/client/mock-adapter.ts')
const { createPanelModel } = await import('../../src/client/panel-model.ts')
const { CortexPanel } = await import('../../src/client/panel.ts')

installGlobals()

type Handle = Awaited<ReturnType<typeof mount>>

async function clickButton(handle: Handle, label: RegExp): Promise<void> {
  const node = handle.buttons().find(item => label.test(String(item.textContent ?? '')))
  if (node === undefined) throw new Error(`no button matching ${String(label)}`)
  node.dispatch(new MiniEvent('click'))
  await settle()
}

const DEAD_LETTER_JOB = {
  id: 'dl-1',
  runner: 'fail-fast',
  status: 'dead-letter',
  startedAt: '2026-09-28T09:02:11.536Z',
  finishedAt: '2026-09-28T09:02:11.579Z',
  exitCode: 1,
  retryCount: 3,
  maxRetries: 3,
  // The reason, as the host now reports it: `error` is empty here precisely
  // because the dead-letter attempt is a later one whose `error` was cleared.
  lastError: 'exit code 1',
}

const SUCCEEDED_JOB = {
  id: 'ok-1',
  runner: 'cortex-verify',
  status: 'succeeded',
  startedAt: '2026-09-28T08:42:24.244Z',
  finishedAt: '2026-09-28T08:42:54.321Z',
  exitCode: 0,
}

async function mountJobs(): Promise<{ handle: Handle; model: { dispose(): void } }> {
  const transport = createMockTransport({
    handlers: { 'jobs.list': () => ({ ok: true, value: [DEAD_LETTER_JOB, SUCCEEDED_JOB] }) },
  })
  const model = createPanelModel(createCortexApi(transport.call))
  const handle = await mount(CortexPanel as never, { model })
  await clickButton(handle, /^Jobs$/)
  return { handle, model }
}

describe('jobs tab · badge tone', () => {
  it('renders danger and ok as visually distinct badges, not the shared grey default', async () => {
    const { handle, model } = await mountJobs()

    const danger = handle.queryOne('.cx-badge-danger')
    const ok = handle.queryOne('.cx-badge-ok')
    expect(danger, 'dead-letter row must render a danger badge').not.toBeNull()
    expect(ok, 'succeeded row must render an ok badge').not.toBeNull()

    const dangerStyle = String(danger?.getAttribute('style') ?? '')
    const okStyle = String(ok?.getAttribute('style') ?? '')

    // The shared base style alone is border + size, no colour: that was the bug.
    expect(dangerStyle).toContain('color: #ff9d8a')
    expect(dangerStyle).toContain('background: rgba(200,90,60,0.18)')
    expect(okStyle).toContain('color: #8fe0b0')

    // and the two must not collapse into one another
    expect(dangerStyle).not.toBe(okStyle)
    expect(danger?.textContent).toContain('dead-letter')
    expect(ok?.textContent).toContain('succeeded')

    model.dispose()
  })

  it('shows the failure reason on the row and offers Retry for a dead-letter job', async () => {
    const { handle, model } = await mountJobs()

    // The reason is visible even though the host reports no `error` for it.
    expect(handle.text()).toContain('exit code 1')
    // The retry affordance for a dead-letter row is still wired.
    const retry = handle.buttons().find(node => node.textContent === 'Retry')
    expect(retry, 'a dead-letter row must offer Retry').toBeDefined()
    expect(String(retry?.getAttribute('title') ?? '')).toContain('jobs.retry')
    // The exhausted-retry counter is shown alongside it.
    expect(handle.text()).toContain('retry 3/3')

    model.dispose()
  })
})
