import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * M3 GUARD: one scope cache for the whole plugin.
 *
 * There were two: `ScopeCache` (memory, richer — it also resolves the branch)
 * and `TaskScopeCache` (todo + logs + progress, pid only). Same TTLs, same
 * probe shape, same key, separate maps. So the git probes ran twice for one
 * cwd. Worse in a live session: the memory injector resolves the scope on every
 * prompt assembly, so the memory cache is warm and the task cache is still
 * cold — todos and logs paid fresh `git` spawns for a cwd the plugin had
 * already probed.
 *
 * This file counts `spawn` calls (that is what a scope probe IS: `gitx` spawns
 * `git`) against a REAL repository, so "the second cache probed again" shows
 * up as a process, not as an opinion.
 */

const spawnCount = vi.hoisted(() => ({ value: 0 }))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    const command = String(args[0])
    if (command === 'git' || command.endsWith('/git')) spawnCount.value += 1
    return actual.spawn(...args)
  }) as typeof actual.spawn
  return { ...actual, spawn, default: { ...actual, spawn } }
})

const { scopeCache } = await import('../src/host/modules/memory/runtime.ts')
const { sharedTaskScopes } = await import('../src/host/modules/todo/scope.ts')
const { projectId } = await import('../src/lib/pid.ts')

let repo = ''

beforeAll(async () => {
  repo = join(process.cwd(), '.dev', `m3-repo-${String(process.pid)}`)
  await mkdir(repo, { recursive: true })
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }) }
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=m3@example.invalid', '-c', 'user.name=M3', 'commit', '-q', '--allow-empty', '-m', 'init')
  spawnCount.value = 0
})

afterAll(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {})
})

describe('M3: one scope cache, one set of git probes', () => {
  it('the task modules share the memory scope cache instance', () => {
    expect(sharedTaskScopes(), 'todo/logs/progress must resolve through the SAME cache memory warms').toBe(scopeCache)
  })

  it('after memory warmed a cwd, todo/logs/progress probe nothing', async () => {
    const memory = await scopeCache.resolve(repo)
    expect(memory.inRepo).toBe(true)
    const coldProbes = spawnCount.value
    spawnCount.value = 0

    const task = await sharedTaskScopes().resolve(repo)
    const warmProbes = spawnCount.value
    spawnCount.value = 0

    console.log(`BENCH scope resolve of one real repo cwd: memory cold ${String(coldProbes)} git spawns, task modules after it ${String(warmProbes)} git spawns`)
    expect(warmProbes, 'a cwd the plugin already probed must not be probed again').toBe(0)
    // And the answer is the same one, derived from the same ground truth.
    expect(task.pid).toBe(memory.pid)
    expect(task.pid).toBe(await projectId({ cwd: repo }))
    expect(task.cwd).toBe(repo)
    expect(task.inRepo).toBe(true)
  })

  it('a different cwd is still probed once, then cached for every module', async () => {
    const other = join(repo, 'nested')
    await mkdir(other, { recursive: true })
    spawnCount.value = 0
    const first = await scopeCache.resolve(other)
    const firstProbes = spawnCount.value
    spawnCount.value = 0
    const second = await sharedTaskScopes().resolve(other)
    const secondProbes = spawnCount.value
    console.log(`BENCH second cwd: cold ${String(firstProbes)} git spawns, then task modules ${String(secondProbes)}`)
    expect(firstProbes).toBeGreaterThan(0)
    expect(secondProbes).toBe(0)
    expect(second.pid).toBe(first.pid)
    await rm(other, { recursive: true, force: true }).catch(() => {})
  })
})
