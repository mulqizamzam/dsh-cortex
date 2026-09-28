import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampText, trimToBudget, capValue, DEFAULT_CAPS } from '../src/lib/caps.ts'
import { errorMessage, makeLogger } from '../src/lib/errors.ts'
import { appendMdCapped, dirBytes, listDir, readJsonSafe, writeJsonAtomic } from '../src/lib/fsx.ts'
import { branchMatches, currentBranch, repoRoot } from '../src/lib/gitx.ts'
import { envStateRoot, resolveStateRoot } from '../src/lib/home.ts'
import { isIsoDate, isoDate, isoStamp, newId, shiftDate } from '../src/lib/ids.ts'
import { normalizeGitRemote, projectId } from '../src/lib/pid.ts'
import { hasBracePair, neutralize, neutralizeAll } from '../src/lib/sanitize.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

let work = ''
beforeEach(async () => { work = await makeTempRoot('dsh-cortex-lib-') })
afterEach(async () => { await removeTempRoot(work) })

describe('home (state root)', () => {
  it('prefers the host dshHomePath service', () => {
    const root = resolveStateRoot(name => (name === 'dshHomePath' ? (...segs: string[]) => `/host/${segs.join('/')}` : undefined))
    expect(root).toBe('/host/dsh-cortex')
  })
  it('falls back to $DSH_HOME, else $HOME/.dsh, never throwing', () => {
    expect(envStateRoot({ DSH_HOME: '/a' })).toBe(join('/a', 'dsh-cortex'))
    expect(envStateRoot({ HOME: '/b' })).toBe(join('/b', '.dsh', 'dsh-cortex'))
    expect(envStateRoot({ DSH_HOME: '  ', HOME: '/b' })).toBe(join('/b', '.dsh', 'dsh-cortex'))
    expect(envStateRoot({})).toBe(join('.dsh', 'dsh-cortex'))
  })
  it('a throwing service still yields a string root', () => {
    expect(typeof resolveStateRoot(() => { throw new Error('no service') }, '/fallback')).toBe('string')
  })
})

describe('ids', () => {
  it('newId is 12 crypto hex and unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()))
    expect(ids.size).toBe(100)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/)
  })
  it('dates are local and file-name safe', () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(isIsoDate(isoDate())).toBe(true)
    expect(isoStamp(new Date('2026-01-05T06:07:08.009Z'))).not.toContain(':')
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('caps (P2)', () => {
  it('clampText collapses whitespace and marks the cut', () => {
    expect(clampText('  a\n\nb  ', 10)).toBe('a b')
    expect(clampText('abcdefghij', 5)).toBe('abcd…')
    expect(clampText('abc', 0)).toBe('')
  })
  it('trimToBudget keeps whole items plus an omission line', () => {
    const items = ['one', 'two', 'three', 'four']
    expect(trimToBudget(items, 18).omitted).toBe(0)
    const tight = trimToBudget(items, 13)
    expect(tight.omitted).toBeGreaterThan(0)
    expect(tight.text.length).toBeLessThanOrEqual(13)
    expect(tight.text).toMatch(/more —/)
    expect(trimToBudget(['aa', 'bb'], 1).kept).toEqual([])
  })
  it('capValue falls back rather than disabling a track', () => {
    expect(capValue(0, DEFAULT_CAPS.entryChars)).toBe(400)
    expect(capValue('nope', 10)).toBe(10)
    expect(capValue(12.7, 10)).toBe(12)
  })
})

describe('fsx (P4)', () => {
  it('readJsonSafe quarantines a corrupt file and never throws', async () => {
    const dir = join(work, 'user', 'entries')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'a1.json')
    await writeFile(file, '{"id":"a1","con', 'utf8')
    const warnings: string[] = []
    const value = await readJsonSafe(file, { fallback: null, quarantineDir: join(work, 'quarantine'), warn: m => warnings.push(m) })
    expect(value).toBeNull()
    const quarantined = await listDir(join(work, 'quarantine'), 10)
    expect(quarantined.names).toHaveLength(1)
    expect(quarantined.names[0]).toMatch(/^a1\.json\.corrupt-/)
    expect((await listDir(dir, 10)).names).toEqual([])
    expect(warnings.join(' ')).toContain('quarantined')
  })

  it('an absent or empty file is the fallback, with no quarantine', async () => {
    const empty = join(work, 'empty.json')
    await writeFile(empty, '  \n', 'utf8')
    expect(await readJsonSafe(empty, { fallback: 'fb', quarantineDir: join(work, 'q') })).toBe('fb')
    expect(await listDir(join(work, 'q'), 5)).toEqual({ names: [], truncated: false })
    expect(await readJsonSafe(join(work, 'nope.json'), { fallback: 'fb', quarantineDir: join(work, 'q') })).toBe('fb')
  })

  it('atomic write leaves no temp file, and an orphan stays invisible', async () => {
    const file = join(work, 'x.json')
    await writeJsonAtomic(file, { gen: 1 })
    await writeFile(join(work, '.x.json.tmp-deadbeef'), 'partial', 'utf8')
    expect((await listDir(work, 20)).names).toEqual(['x.json'])
    await writeJsonAtomic(file, { gen: 2 })
    expect(await readJsonSafe(file, { fallback: null, quarantineDir: join(work, 'q') })).toEqual({ gen: 2 })
  })

  it('appendMdCapped clamps lines and rolls the day file', async () => {
    const file = join(work, 'daily', '2026-01-01.md')
    expect((await appendMdCapped(file, 'x'.repeat(500), 40, 1000, clampText)).dropped).toBe(false)
    for (let index = 0; index < 8; index += 1) await appendMdCapped(file, `l${String(index)} ${'y'.repeat(60)}`, 100, 200, clampText)
    const names = (await listDir(join(work, 'daily'), 20)).names
    expect(names).toContain('2026-01-01.md')
    expect(names.some(name => /^2026-01-01-2\.md$/.test(name))).toBe(true)
    expect((await appendMdCapped(join(work, 'blank.md'), '   ', 20, 100, clampText)).dropped).toBe(true)
  })
})

describe('pid + branch scope', () => {
  it('normalizeGitRemote strips scheme, user, port, .git and host case', () => {
    expect(normalizeGitRemote('git@GitHub.com:omdsh-dev/dsh-mnemon.git')).toBe('github.com/omdsh-dev/dsh-mnemon')
    expect(normalizeGitRemote('https://user:token@github.com/a/b.git')).toBe('github.com/a/b')
    expect(normalizeGitRemote('ssh://git@gitlab.example.com:22/group/proj')).toBe('gitlab.example.com/group/proj')
    expect(normalizeGitRemote('')).toBeUndefined()
    expect(normalizeGitRemote(undefined)).toBeUndefined()
  })
  it('projectId is stable across remote spellings, cwd otherwise', async () => {
    const viaRemote = await projectId({ cwd: '/nope', remoteUrl: 'git@github.com:acme/app.git' })
    const other = await projectId({ cwd: join(work, 'elsewhere'), remoteUrl: 'https://GitHub.com/acme/app' })
    expect(viaRemote).toBe(other)
    expect(viaRemote).toMatch(/^[0-9a-f]{16}$/)
    const dir = join(work, 'repo')
    await mkdir(dir, { recursive: true })
    expect(await projectId({ cwd: dir })).toMatch(/^[0-9a-f]{16}$/)
  })
  it('branchMatches never guesses on an unknown branch (P8)', () => {
    expect(branchMatches(undefined, null)).toBe(true)
    expect(branchMatches([], 'main')).toBe(true)
    expect(branchMatches(['feat/a'], null)).toBe(false)
    expect(branchMatches(['feat/a'], 'feat/a')).toBe(true)
  })
  it('git probes fail silently outside a repository', async () => {
    expect(await currentBranch(work)).toBeUndefined()
    expect(await repoRoot(join(work, 'missing'))).toBeUndefined()
  })
})

describe('errors', () => {
  it('logger prefixes scope and survives a broken console', () => {
    const originalWarn = console.warn
    const seen: unknown[] = []
    console.warn = (...parts: unknown[]) => { seen.push(parts) }
    try {
      makeLogger('cortex-test').warn('boom', new Error('nested'))
    } finally { console.warn = originalWarn }
    expect((seen[0] as unknown[])[0]).toBe('[cortex-test]')
    expect(JSON.stringify(seen[0])).toContain('nested')
  })
  it('errorMessage always produces a usable string', () => {
    expect(errorMessage(new Error('x'))).toBe('x')
    expect(errorMessage(new Error(''))).toBe('Error')
    expect(errorMessage('text')).toBe('text')
    expect(errorMessage(undefined)).not.toBe('')
  })
})

describe('sanitize (host issue-class #53)', () => {
  it('neutralizes delimiter pairs, leaves single braces alone', () => {
    expect(neutralize('{{value}}')).toBe('{ {value} }')
    expect(neutralize('a {{ b }} c')).toBe('a { { b } } c')
    expect(neutralize('single { and } stay')).toBe('single { and } stay')
    expect(neutralize('')).toBe('')
    expect(neutralize(undefined as unknown as string)).toBe('')
  })
  it('output never contains a pair, and repeated calls are stable', () => {
    const dirty = '{{{{nested}}}}'
    const once = neutralize(dirty)
    expect(hasBracePair(once)).toBe(false)
    expect(neutralize(once)).toBe(once)
    // One-pass replaceAll would leave `{ {{` here; the run-breaking rule must not.
    for (const dirty of ['{{{x}}}', '{{}{}}', 'a{{{{b}}}}c', '{{', '}}']) {
      expect(hasBracePair(neutralize(dirty))).toBe(false)
    }
  })
  it('neutralizeAll maps without dropping rows', () => {
    expect(neutralizeAll(['{{a}}', 'plain', '']))
      .toEqual(['{ {a} }', 'plain', ''])
  })
})

describe('fsx.dirBytes', () => {
  it('sums files recursively and stops past the ceiling', async () => {
    await mkdir(join(work, 'a', 'b'), { recursive: true })
    await writeFile(join(work, 'a', 'one.txt'), '12345', 'utf8')
    await writeFile(join(work, 'a', 'b', 'two.txt'), '123', 'utf8')
    expect(await dirBytes(join(work, 'a'))).toBe(8)
    // Early exit: over the ceiling means "at least this much", not an exact total.
    expect(await dirBytes(join(work, 'a'), 4)).toBeGreaterThan(4)
    expect(await dirBytes(join(work, 'missing'))).toBe(0)
  })
})

describe('caps (amendment 3)', () => {
  it('state quota ships at 64 MiB', () => {
    expect(DEFAULT_CAPS.stateQuotaBytes).toBe(67108864)
  })
})
