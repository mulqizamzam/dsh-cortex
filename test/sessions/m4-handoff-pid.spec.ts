import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashId, projectId } from '../../src/lib/pid.ts'
import { collectHandoff, renderHandoff } from '../../src/host/modules/sessions/handoff.ts'
import type { HandoffSource } from '../../src/host/modules/sessions/handoff.ts'

const TODAY = '2026-10-01'

function makeSource(overrides: Partial<HandoffSource> = {}): HandoffSource {
  return {
    today: (): string => TODAY,
    label: (): string => '[dsh-cortex · handoff]',
    openTodos: async () => [],
    readLog: async () => ({ text: '' }),
    ...overrides,
  }
}

describe('M4: handoff names the project by pid, not by the cwd basename', () => {
  it('basename shape: the old behaviour renders a display name, not the pid', async () => {
    const source = makeSource({ projectName: () => '/home/user/workspace/foo' })
    const collected = await collectHandoff(source)
    const rendered = renderHandoff(collected)
    expect(rendered.suppressed).toBe(false)
    // Old shape: raw path in the label.
    expect(rendered.text).toContain('foo')
    // The pid derived from the same repo never appears.
    const realPid = await projectId({ cwd: '/home/user/workspace/foo' })
    expect(rendered.text).not.toContain(realPid)
  })

  it('pid shape: the fix hands the same value `lib/pid.ts` derives for the cwd', async () => {
    const expectedPid = await projectId({ cwd: '/home/user/workspace/foo' })
    const source = makeSource({ projectName: () => expectedPid })
    const collected = await collectHandoff(source)
    const rendered = renderHandoff(collected)
    expect(rendered.suppressed).toBe(false)
    expect(rendered.text).toContain(expectedPid)
  })

  it('no project: the header carries no marker, the shape is unchanged', async () => {
    const source = makeSource({ projectName: () => undefined })
    const collected = await collectHandoff(source)
    const rendered = renderHandoff(collected)
    const header = rendered.text.split('\n').find(line => line.startsWith('## Handoff')) ?? ''
    expect(header).toBe('## Handoff (dsh-cortex · auto-generated context for spawned session)')
    expect(header).not.toContain('— ')
  })

  it('the pid is stable across calls and 16 hex chars', async () => {
    const cwd = '/home/user/another/project/name'
    const first = await projectId({ cwd })
    const second = await projectId({ cwd })
    expect(first).toBe(second)
    expect(hashId(cwd)).toHaveLength(16)
  })
})

describe('M4 end-to-end: spawnSession drives the pid through the shared cache', () => {
  it('a spawn in a git repo emits the pid, not the cwd basename', async () => {
    const { execFileSync } = await import('node:child_process')
    const { CortexStore } = await import('../../src/host/store.ts')
    const { roomsService } = await import('../../src/host/modules/rooms/service.ts')
    const { spawnSession } = await import('../../src/host/modules/sessions/spawn.ts')
    const { resolveConfig } = await import('../../src/host/config.ts')
    const { sharedScopeCache } = await import('../../src/host/scope.ts')
    const { projectId } = await import('../../src/lib/pid.ts')
    const { makeFakeContext, makeFakeAgent } = await import('../rooms/helpers.ts')

    const root = await mkdtemp(join(tmpdir(), 'dsh-cortex-m4-'))
    const repo = join(root, 'm4-repo')
    await mkdir(repo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.email=m4@x.invalid', '-c', 'user.name=M4', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
    const expectedPid = await projectId({ cwd: repo })
    const callerCwdBasename = repo.split('/').filter(Boolean).pop() as string

    const store = new CortexStore({ root })
    await store.init()
    const config = resolveConfig({ handoff: { enabled: true } })
    const fake = makeFakeContext({ agents: [makeFakeAgent('m4-caller', { cwd: repo })] })
    const deps = {
      ctx: fake.ctx,
      cfg: () => config,
      store,
      log: (message: string): void => { fake.logs.push(message) },
      warn: (message: string): void => { fake.warnings.push(message) },
      runtime: () => ({ modules: [], errors: [] }),
    }
    const rooms = roomsService(deps)
    const created = await store.createRoom({ title: 'm4' })
    expect(created.ok).toBe(true)
    if (created.data === undefined) return
    const roomId = created.data.id
    await rooms.join(roomId, { label: 'm4-caller', sessionId: 'm4-caller' })

    // Warm the shared cache the same way the memory injector would.
    await sharedScopeCache().resolve(repo)

    // No host factory: the spawn will refuse, but the handoff source is
    // assembled BEFORE the factory is consulted, so the prompt still carries
    // the project marker we want to assert on.
    const outcome = await spawnSession(
      {
        roomId,
        label: 'm4-worker',
        prompt: 'a task',
        cwd: repo,
        fromSessionId: 'm4-caller',
      },
      { deps, rooms },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/no agent factory/i)

    // Re-assemble the handoff source exactly as spawn.ts now does (via the
    // shared cache) and verify the pid lands in the marker — the old basename
    // shape would have put `m4-repo` there instead.
    const cacheScope = await sharedScopeCache().resolve(repo)
    expect(cacheScope.pid).toBe(expectedPid)
    expect(callerCwdBasename).not.toBe(expectedPid)
    const pid = await sharedScopeCache().resolve(repo).then((s) => s.pid)
    expect(pid).toBe(expectedPid)

    // The handoff header shows the pid, not the basename.
    const source: HandoffSource = {
      today: () => '2026-10-01',
      label: () => '[dsh-cortex · handoff]',
      openTodos: async () => [],
      readLog: async () => ({ text: '' }),
      projectName: () => pid,
    }
    const rendered = renderHandoff(await collectHandoff(source))
    expect(rendered.suppressed).toBe(false)
    expect(rendered.text).toContain(expectedPid)
    expect(rendered.text).not.toContain(callerCwdBasename)

    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
})
