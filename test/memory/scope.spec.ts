import { afterEach, describe, expect, it } from 'vitest'
import { ScopeCache } from '../../src/host/modules/memory/scope.ts'
import { cwdOf, sessionIdOf } from '../../src/host/modules/memory/scope.ts'
import { RENDER_MAX_AGE_MS, createMemoryInjector } from '../../src/host/modules/memory/runtime.ts'
import { INJECT_LABEL } from '../../src/host/config.ts'
import { removeTempRoot } from '../helpers.ts'
import { fakeAgent, makeHarness, seedEntries } from './fixture.ts'
import type { Harness } from './fixture.ts'

/**
 * Scope resolution and the async cache in front of the render. These are the
 * two pieces that decide whether a turn is fast and whether a memory shows up at
 * all, so they are tested without git and without a host.
 */

let harness: Harness | undefined

afterEach(async () => {
  if (harness !== undefined) await removeTempRoot(harness.root)
  harness = undefined
})

function probeCounter(scope: { root?: string; remote?: string; branch?: string }) {
  const calls = { root: 0, remote: 0, branch: 0 }
  const cache = new ScopeCache({
    repoRoot: async () => {
      calls.root += 1
      return scope.root
    },
    originRemote: async () => {
      calls.remote += 1
      return scope.remote
    },
    currentBranch: async () => {
      calls.branch += 1
      return scope.branch
    },
    projectId: async () => 'stablepid0000000',
  })
  return { cache, calls }
}

describe('ScopeCache', () => {
  it('probes once per window, not once per turn (C-36)', async () => {
    const { cache, calls } = probeCounter({ root: '/repo', remote: 'git@github.com:acme/app.git', branch: 'main' })
    const first = await cache.resolve('/repo/work')
    const second = await cache.resolve('/repo/work')
    expect(first.pid).toBe('stablepid0000000')
    expect(first.branch).toBe('main')
    expect(first.inRepo).toBe(true)
    expect(calls).toEqual({ root: 1, remote: 1, branch: 1 })
    expect(second).toBe(first)
  })

  it('re-probes after the TTL and on an explicit forget', async () => {
    let now = 0
    const cache = new ScopeCache(
      { repoRoot: async () => '/repo', originRemote: async () => undefined, currentBranch: async () => 'main', projectId: async () => 'stablepid0000000' },
      { now: () => now, ttlMs: 30_000, missTtlMs: 5_000 },
    )
    await cache.resolve('/repo')
    now += 29_000
    await cache.resolve('/repo')
    expect(cache.size).toBe(1)
    now += 2_000
    await cache.resolve('/repo')
    expect(cache.size).toBe(1)
    cache.forget('/repo')
    expect(cache.size).toBe(0)
  })

  it('a detached or missing branch is UNKNOWN, which is not "no branches" (P8)', async () => {
    const detached = probeCounter({ root: '/repo', branch: undefined })
    const scope = await detached.cache.resolve('/repo')
    expect(scope.branch).toBeNull()
    const empty = await new ScopeCache({
      repoRoot: async () => '/repo',
      originRemote: async () => '',
      currentBranch: async () => '',
      projectId: async () => 'stablepid0000000',
    }).resolve('/repo')
    expect(empty.branch).toBeNull()
    expect(empty.remoteUrl).toBeUndefined()
  })

  it('no cwd means no project, and nothing is probed', async () => {
    const { cache, calls } = probeCounter({ root: '/repo', branch: 'main' })
    const scope = await cache.resolve(undefined)
    expect(scope.pid).toBeUndefined()
    expect(scope.branch).toBeNull()
    expect(calls).toEqual({ root: 0, remote: 0, branch: 0 })
    expect(await cache.resolve('   ')).toEqual({ branch: null, inRepo: false })
  })

  it('a throwing probe degrades to "no project, unknown branch" instead of failing the turn', async () => {
    const cache = new ScopeCache({
      repoRoot: async () => {
        throw new Error('git is missing')
      },
      originRemote: async () => undefined,
      currentBranch: async () => undefined,
      projectId: async () => 'stablepid0000000',
    })
    const scope = await cache.resolve('/somewhere')
    expect(scope.branch).toBeNull()
    expect(scope.pid).toBeUndefined()
    expect(scope.inRepo).toBe(false)
    expect(cache.peek('/somewhere')).toEqual(scope)
  })

  it('the cache is bounded, so a long-lived host cannot grow it', async () => {
    const cache = new ScopeCache({
      repoRoot: async cwd => cwd,
      originRemote: async () => undefined,
      currentBranch: async () => 'main',
      projectId: async input => `pid${input.cwd.slice(-6)}`,
    })
    for (let index = 0; index < 60; index += 1) await cache.resolve(`/repo/${index}`)
    expect(cache.size).toBeLessThanOrEqual(32)
  })

  it('reads the agent defensively from whatever the host hands over', () => {
    expect(cwdOf(fakeAgent('/work/one'))).toBe('/work/one')
    expect(cwdOf({ session: { header: { cwd: '  ' } } })).toBeUndefined()
    expect(cwdOf(undefined)).toBeUndefined()
    expect(cwdOf(null)).toBeUndefined()
    expect(cwdOf('nonsense')).toBeUndefined()
    expect(sessionIdOf(fakeAgent('/work', 'agent-9'))).toBe('agent-9')
    expect(sessionIdOf({ id: 12 })).toBeUndefined()
  })
})

describe('the injection cache', () => {
  it('serves a memoised block, refreshes in the background, and never blocks', async () => {
    harness = await makeHarness({}, { pid: 'cachepid000000', branch: 'main' })
    await seedEntries(harness.store, 2, { track: 'global', prefix: 'cached fact' })
    let now = 0
    const injector = createMemoryInjector(harness.deps, { now: () => now, scopes: harness.scopes })
    expect(injector.text({ agent: fakeAgent(harness.cwd) })).toBe('')
    await injector.refresh(harness.cwd)
    const first = injector.text({ agent: fakeAgent(harness.cwd) })
    expect(first.startsWith(INJECT_LABEL)).toBe(true)
    expect(first).toContain('cached fact')
    // Inside the TTL the same string comes back without a new render.
    now += 1_000
    expect(injector.text({ agent: fakeAgent(harness.cwd) })).toBe(first)
    // Past the TTL the stale block is served while a fresh one is built.
    now += 10_000
    expect(injector.text({ agent: fakeAgent(harness.cwd) })).toBe(first)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(injector.text({ agent: fakeAgent(harness.cwd) })).toBe(first)
    injector.invalidate()
    expect(injector.cached).toBe(0)
  })

  it('withholds memory once the memo is older than the max age', async () => {
    harness = await makeHarness({}, { pid: 'cachepid000000', branch: null })
    await seedEntries(harness.store, 1, { track: 'global', prefix: 'old fact' })
    let now = 0
    const injector = createMemoryInjector(harness.deps, { now: () => now, scopes: harness.scopes, ttlMs: 1 })
    await injector.refresh(harness.cwd)
    expect(injector.text({ agent: fakeAgent(harness.cwd) })).toContain('old fact')
    now = RENDER_MAX_AGE_MS + 1
    expect(injector.text({ agent: fakeAgent(harness.cwd) })).toBe('')
  })

  it('inject.enabled=false is silent, and a broken store cannot throw', async () => {
    harness = await makeHarness({ inject: { enabled: false, user: true, global: true, project: true, todo: true } }, { pid: 'cachepid000000', branch: null })
    const injector = createMemoryInjector(harness.deps, { scopes: harness.scopes })
    await injector.refresh(harness.cwd)
    expect(injector.text({ agent: fakeAgent(harness.cwd) })).toBe('')
    // A root that cannot be read still produces no throw, only a notice block.
    const ready = harness
    const broken = createMemoryInjector(
      { ...ready.deps, cfg: () => ({ ...ready.config, inject: { ...ready.config.inject, enabled: true } }) },
      { scopes: ready.scopes },
    )
    const result = await broken.refresh('/does/not/exist')
    expect(result.block.startsWith(INJECT_LABEL)).toBe(true)
  })
})
