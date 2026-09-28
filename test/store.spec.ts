import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirBytes } from '../src/lib/fsx.ts'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore, LIST_CAP, SCHEMA_VERSION, STATE_QUOTA_ERROR, STATE_READ_ONLY_ERROR, selectForBranch } from '../src/host/store.ts'
import { DEFAULT_CAPS } from '../src/lib/caps.ts'
import type { Entry } from '../src/host/types.ts'
import { makeTempRoot, removeTempRoot } from './helpers.ts'

let root = ''
let warnings: string[] = []
let clock = new Date('2026-03-04T05:06:07.000Z')
const pid = 'a'.repeat(16)

function makeStore(): CortexStore {
  return new CortexStore({ root, caps: DEFAULT_CAPS, warn: message => warnings.push(message), now: () => clock })
}
let store = makeStore()

beforeEach(async () => {
  root = await makeTempRoot('dsh-cortex-store-')
  warnings = []
  clock = new Date('2026-03-04T05:06:07.000Z')
  store = makeStore()
  expect((await store.init()).ok).toBe(true)
})
afterEach(async () => { await removeTempRoot(root) })

describe('scaffold', () => {
  it('writes schema.json and reports a snapshot', async () => {
    const snapshot = await store.statusSnapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.data.stateRoot).toBe(root)
    expect((snapshot.data.schema as number)).toBe(SCHEMA_VERSION)
    expect(((snapshot.data.counts as Record<string, number>).quarantined)).toBe(0)
  })
  it('marks a newer on-disk schema as read-only', async () => {
    await writeFile(join(root, 'schema.json'), '{"version":99}', 'utf8')
    const snapshot = await store.statusSnapshot()
    expect(snapshot.ok && (snapshot.data as Record<string, unknown>).readOnly).toBe(true)
  })
})

describe('entries', () => {
  it('adds with caps and structured branch scope', async () => {
    const added = await store.addEntry({ scope: { track: 'user' }, content: `${'z'.repeat(600)} tail`, importance: 9, tags: ['a', 'a'], branches: ['feat/x'] })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.data.content.length).toBeLessThanOrEqual(DEFAULT_CAPS.entryChars)
    expect(added.data.importance).toBe(5)
    expect(added.data.tags).toEqual(['a'])
    const listed = await store.listEntries({ track: 'user' })
    expect(listed.ok && listed.data.entries).toHaveLength(1)
  })

  it('project entries live under projects/<pid>/entries', async () => {
    expect((await store.ensureProject(pid, { cwd: '/repo', remoteUrl: 'github.com/o/r' })).ok).toBe(true)
    const added = await store.addEntry({ scope: { track: 'project', pid }, content: 'use pnpm' })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect((await store.listEntries({ track: 'project', pid })).ok).toBe(true)
    const found = await store.listEntries({ track: 'project', pid })
    expect(found.ok && found.data.entries[0]?.pid).toBe(pid)
  })

  it('update / archive / restore / delete move exactly one file', async () => {
    const added = await store.addEntry({ scope: { track: 'global' }, content: 'temp' })
    if (!added.ok) return expect(added.error).toBe('')
    const id = added.data.id
    expect((await store.updateEntry(id, { content: 'final', branches: null })).ok).toBe(true)
    expect((await store.archiveEntry(id)).ok).toBe(true)
    const afterArchive = await store.listEntries({ track: 'global' })
    expect(afterArchive.ok && afterArchive.data.entries).toHaveLength(0)
    const archived = await store.listEntries({ track: 'global', archived: true })
    expect(archived.ok && archived.data.entries.map(entry => entry.id)).toEqual([id])
    expect((await store.restoreEntry(id)).ok).toBe(true)
    const active = await store.listEntries({ track: 'global' })
    expect(active.ok && active.data.entries.map(entry => entry.id)).toEqual([id])
    expect((await store.deleteEntry(id)).ok).toBe(true)
    expect((await store.deleteEntry(id)).data).toBe(false)
  })

  it('a corrupt entry file is quarantined, listing still succeeds', async () => {
    const dir = join(root, 'user', 'entries')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'bad.json'), '{"id":"bad",', 'utf8')
    await store.addEntry({ scope: { track: 'user' }, content: 'good' })
    const listed = await store.listEntries({ track: 'user' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.entries.map(entry => entry.content)).toEqual(['good'])
    expect(warnings.join(' ')).toContain('quarantined')
  })

  it('refuses traversal-ish ids', async () => {
    expect((await store.deleteEntry('../escape')).data).toBe(false)
    expect((await store.getPrompt('../../x')).data).toBeNull()
  })

  it('selectForBranch: unknown branch renders unscoped only (P8)', async () => {
    const unscoped: Entry = { id: 'a'.repeat(12), track: 'global', content: 'always', importance: 3, tags: [], createdAt: '', updatedAt: '', origin: 'user' }
    const scoped: Entry = { ...unscoped, id: 'b'.repeat(12), content: 'scoped', branches: ['feat/a'] }
    expect(selectForBranch([unscoped, scoped], null).map(entry => entry.id)).toEqual([unscoped.id])
    expect(selectForBranch([unscoped, scoped], 'feat/a').map(entry => entry.id)).toEqual([unscoped.id, scoped.id])
    await store.addEntry({ scope: { track: 'global' }, content: 'always' })
    await store.addEntry({ scope: { track: 'global' }, content: 'scoped', branches: ['feat/a'] })
    const unknown = await store.listEntries({ track: 'global', branch: null })
    expect(unknown.ok && unknown.data.entries.map(entry => entry.content)).toEqual(['always'])
    const known = await store.listEntries({ track: 'global', branch: 'feat/a' })
    expect(known.ok && known.data.entries).toHaveLength(2)
  })
})

describe('todos, logs, pending, prompts, inject', () => {
  it('todo add/complete/remove with completedAt', async () => {
    const added = await store.addTodo({ track: 'work', text: 'ship M0', urgent: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const done = await store.updateTodo(added.data.id, { done: true })
    expect(done.ok && (done.data?.completedAt ?? '')).toBe('2026-03-04T05:06:07.000Z')
    expect((await store.listTodos({ openOnly: true })).data).toEqual([])
    expect((await store.listTodos()).data).toHaveLength(1)
    expect((await store.removeTodo(added.data.id)).data).toBe(true)
  })

  it('a corrupt todos.json costs that file only', async () => {
    await mkdir(join(root, 'todos'), { recursive: true })
    await writeFile(join(root, 'todos', 'life.json'), 'nope{', 'utf8')
    expect((await store.addTodo({ track: 'daily', text: 'still works' })).ok).toBe(true)
    expect((await store.listTodos()).data).toHaveLength(1)
  })

  it('log append + read, capped on write', async () => {
    expect((await store.logAppend({ scope: 'daily', text: 'started' })).ok).toBe(true)
    const long = await store.logAppend({ scope: 'daily', text: `x${'z'.repeat(900)}` })
    expect(long.ok && (long.data.line.length <= DEFAULT_CAPS.logLineChars + 4)).toBe(true)
    const read = await store.logRead({ scope: 'daily', date: '2026-03-04' })
    expect(read.ok && String(read.data.text).split('\n').filter(line => line.startsWith('- '))).toHaveLength(2)
    expect((await store.logAppend({ scope: 'project', text: 'needs pid' })).ok).toBe(false)
  })

  it('pending approve/reject keeps an audit row', async () => {
    const item = await store.addPending({ kind: 'memory', proposal: { track: 'global', content: 'fact' }, reason: 'user asked' })
    expect(item.ok).toBe(true)
    if (!item.ok) return
    const approved = await store.approvePending(item.data.id)
    expect(approved.ok && approved.data?.status).toBe('approved')
    expect((await store.listPending({ status: 'pending' })).data).toHaveLength(0)
    expect((await store.listPending({ status: 'approved' })).data).toHaveLength(1)
    expect((await store.rejectPending('nope')).data).toBeNull()
  })

  it('prompt CRUD and inject queue consume', async () => {
    const doc = await store.addPrompt({ title: 'Review', body: 'walk the diff', category: 'qa' })
    expect(doc.ok).toBe(true)
    if (!doc.ok) return
    expect((await store.updatePrompt(doc.data.id, { enabled: false })).data?.enabled).toBe(false)
    expect((await store.listPrompts({ enabled: false })).data).toHaveLength(1)
    const pushed = await store.injectPush('sess-1', { promptId: doc.data.id, mode: 'once' })
    expect(pushed.ok && pushed.data.items).toHaveLength(1)
    const consumed = await store.injectConsume('sess-1', [doc.data.id])
    expect(consumed.ok && consumed.data.items).toHaveLength(0)
    expect((await store.deletePrompt(doc.data.id)).data).toBe(true)
  })

  it('a hostile session id cannot escape the inject directory', async () => {
    expect((await store.injectPush('../../escaped', { promptId: 'a'.repeat(12), mode: 'once' })).ok).toBe(true)
    const names = await listDirNames(join(root, 'inject'))
    expect(names).toHaveLength(1)
    expect(names.every(name => /^[A-Za-z0-9_-]+\.json$/.test(name))).toBe(true)
  })
})

describe('rooms', () => {
  it('seq stays monotonic across a restart and survives a lost counter', async () => {
    const room = await store.createRoom({ title: 'planning' })
    expect(room.ok).toBe(true)
    if (!room.ok) return
    const id = room.data.id
    await store.joinRoom(id, { label: 'caller', sessionId: 's1', state: 'running' })
    const first = await store.postMessage(id, { text: 'hello', fromSessionId: 's1' })
    expect(first.ok && first.data?.seq).toBe(1)
    const restarted = makeStore()
    const second = await restarted.postMessage(id, { text: 'again' })
    expect(second.ok && second.data?.seq).toBe(2)
    expect((await restarted.readMessages(id)).data?.map(message => message.seq)).toEqual([1, 2])
    expect((await restarted.readMessages(id, { sinceSeq: 1 })).data?.map(message => message.seq)).toEqual([2])
    await writeFile(restarted.paths.roomSeq(id), '', 'utf8')
    const third = await restarted.postMessage(id, { text: 'third' })
    expect(third.ok && third.data?.seq).toBe(3)
  })

  it('members key on session id and refresh in place', async () => {
    const room = await store.createRoom({ title: 'members' })
    if (!room.ok) return expect(room.error).toBe('')
    await store.joinRoom(room.data.id, { label: 'a', sessionId: 's1', state: 'idle' })
    const updated = await store.joinRoom(room.data.id, { label: 'a', sessionId: 's1', state: 'running' })
    expect(updated.ok && updated.data?.members).toHaveLength(1)
    expect(updated.data?.members[0]?.state).toBe('running')
    expect((await store.getRoom(room.data.id)).data?.title).toBe('members')
    expect((await store.getRoom('nope')).data).toBeNull()
  })
})

describe('jobs + purge', () => {
  it('job dir helpers create per-job files and list newest first', async () => {
    const first = await store.createJob({ runner: 'noop', argv: ['/bin/true'], task: 'one' })
    clock = new Date('2026-03-04T06:00:00.000Z')
    const second = await store.createJob({ runner: 'noop', argv: ['/bin/true'], task: 'two' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect((await store.updateJob(first.data.id, { status: 'succeeded', exitCode: 0 })).data?.status).toBe('succeeded')
    expect((await store.listJobs()).data?.map(job => job.id)).toEqual([second.data.id, first.data.id])
    const paths = store.jobPaths(first.data.id)
    expect(paths.dir).toBe(join(root, 'delegation', 'jobs', first.data.id))
    expect(paths.result.endsWith('result.md')).toBe(true)
  })

  it('purgeRoot removes the whole state root (P6)', async () => {
    await store.addEntry({ scope: { track: 'global' }, content: 'bye' })
    expect((await store.purgeRoot()).ok).toBe(true)
    expect(await listDirNames(root)).toEqual([])
  })

  it('LIST_CAP bounds the readdir ceiling', () => {
    expect(LIST_CAP).toBeGreaterThan(0)
  })
})

async function listDirNames(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    return (await readdir(dir)).filter(name => !name.startsWith('.'))
  } catch {
    return []
  }
}

describe('state quota (amendment 3)', () => {
  it('addEntry refuses with the quota message once the root is over budget', async () => {
    const quota = 900
    const tight = new CortexStore({ root, caps: { ...DEFAULT_CAPS, stateQuotaBytes: quota }, warn: m => warnings.push(m), now: () => clock })
    await tight.init()
    let rejected: string | undefined
    let accepted = 0
    for (let index = 0; index < 40; index += 1) {
      const result = await tight.addEntry({ scope: { track: 'global' }, content: `entry ${String(index)} ${'k'.repeat(80)}` })
      if (result.ok) accepted += 1
      else { rejected = result.error; break }
    }
    expect(rejected).toBe(STATE_QUOTA_ERROR)
    expect(accepted).toBeGreaterThan(0)
    expect(accepted).toBeLessThan(40)
    // Refusal wrote nothing: the count equals what succeeded.
    const listed = await tight.listEntries({ track: 'global' })
    expect(listed.ok && listed.data.entries).toHaveLength(accepted)
    expect((await dirBytes(root)) ).toBeLessThanOrEqual(quota + 400)
    // The default quota is far above this, so the same store accepts again.
    expect((await store.addEntry({ scope: { track: 'global' }, content: 'under default quota' })).ok).toBe(true)
  })

  it('quota key is present so config patches can retune it', () => {
    expect(DEFAULT_CAPS.stateQuotaBytes).toBe(67108864)
  })
})

// PARENT (takeover): DESIGN P9 — every persisted model-visible string must be
// brace-free at the WRITE edge, independent of any module's render hygiene.
describe('write-edge brace neutralization (P9, host #53 class)', () => {
  it('entry content, todo text, log line, prompt body and pending proposal are neutralized on store', async () => {
    const hostile = 'deploy {{session}} then {{{{x}}}} on }}'
    const entry = await store.addEntry({ scope: { track: 'global' }, content: hostile })
    expect(entry.ok).toBe(true)
    expect(entry.data?.content).not.toContain('{{')
    expect(entry.data?.content).not.toContain('}}')
    const todo = await store.addTodo({ track: 'life', text: hostile })
    expect(todo.ok && todo.data?.text).toBeDefined()
    expect(todo.data?.text).not.toContain('{{')
    const prompt = await store.addPrompt({ title: 'T', body: hostile })
    expect(prompt.ok === true && (prompt.data as { body: string }).body).not.toContain('{{')
    const pending = await store.addPending({ kind: 'memory', proposal: { content: hostile } })
    expect(pending.ok && JSON.stringify(pending.data?.proposal)).not.toMatch(/\{\{|\}\}/)
    const log = await store.logAppend({ scope: 'daily', text: hostile })
    expect(log.ok).toBe(true)
    const day = await store.logRead({ scope: 'daily', date: '2026-03-04' })
    expect(day.ok && day.data?.text).not.toContain('{{')
    // idempotent: re-neutralizing stored text changes nothing
    if (entry.data) expect((await store.updateEntry(entry.data.id, { content: entry.data.content })).data?.content).toBe(entry.data.content)
  })
})

// PARENT (takeover): SEC-1 / C-19 (REVIEW-R2) — no untrusted key may escape the
// state root. The choke point is `storePaths`; every builder that takes a
// caller-supplied key must reject traversal and fail closed (ok:false).
describe('path traversal is blocked at the storePaths choke point (SEC-1 / C-19)', () => {
  const EXPECTED_TOP = ['quarantine', 'tmp', 'projects', 'rooms', 'daily', 'todos', 'pending', 'prompts', 'inject', 'delegation', 'schema.json']

  it('rejects a project log with a traversal pid and writes nothing outside the root', async () => {
    const result = await store.logAppend({ scope: 'project', pid: '../ESCAPED-LOG', text: 'x' })
    expect(result.ok).toBe(false)
    // No escaped artifact appears in the parent of the state root.
    const siblings = await listDirNames(join(root, '..'))
    expect(siblings.some(name => name.includes('ESCAPED-LOG'))).toBe(false)
    // The root still holds only the expected scaffold (nothing leaked in).
    const top = await listDirNames(root)
    expect(top.every(name => EXPECTED_TOP.includes(name))).toBe(true)
  })

  it('still appends a log for a valid project pid', async () => {
    expect((await store.ensureProject('valid-pid', {})).ok).toBe(true)
    const ok = await store.logAppend({ scope: 'project', pid: 'valid-pid', text: 'x' })
    expect(ok.ok).toBe(true)
  })

  it('rejects an entry under a traversal project id and writes nothing outside the root', async () => {
    const result = await store.addEntry({ scope: { track: 'project', pid: '../ESCAPED-ENTRY' }, content: 'x' })
    expect(result.ok).toBe(false)
    const siblings = await listDirNames(join(root, '..'))
    expect(siblings.some(name => name.includes('ESCAPED-ENTRY'))).toBe(false)
  })

  it('rejects a room id containing traversal', async () => {
    const result = await store.readMessages('../../evil-room')
    expect(result.ok).toBe(false)
  })
})

// PARENT (Phase 1 audit, B1): `postMessage` derives its seq from a
// read-modify-write, so concurrent posts to ONE room must be serialized —
// while different rooms must stay independent (no global lock, no shared counter).
describe('concurrent postMessage is serialized per room (B1)', () => {
  it('two concurrent posts to one room both persist, with distinct seqs', async () => {
    const room = await store.createRoom({ title: 'race' })
    if (!room.ok) throw new Error(room.error)
    const [first, second] = await Promise.all([
      store.postMessage(room.data.id, { text: 'first' }),
      store.postMessage(room.data.id, { text: 'second' }),
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const seqs = [first.ok ? first.data?.seq : -1, second.ok ? second.data?.seq : -1].sort((a, b) => Number(a) - Number(b))
    expect(seqs).toEqual([1, 2])
    const persisted = await store.readMessages(room.data.id, { limit: 50 })
    expect(persisted.data?.map(message => message.seq)).toEqual([1, 2])
    expect(persisted.data?.map(message => message.text).sort()).toEqual(['first', 'second'])
  })

  it('ten concurrent posts to one room lose nothing', async () => {
    const room = await store.createRoom({ title: 'burst' })
    if (!room.ok) throw new Error(room.error)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.postMessage(room.data.id, { text: `m${String(index)}` })),
    )
    expect(results.every(result => result.ok)).toBe(true)
    expect(new Set(results.map(result => (result.ok ? result.data?.seq : -1))).size).toBe(10)
    const persisted = await store.readMessages(room.data.id, { limit: 50 })
    expect(persisted.data?.map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(persisted.data?.map(message => message.text).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `m${String(index)}`).sort(),
    )
  })

  it('a failed write does not poison the room chain', async () => {
    const room = await store.createRoom({ title: 'poison' })
    if (!room.ok) throw new Error(room.error)
    const messagesDir = store.paths.roomMessages(room.data.id)
    // Make the message path a FILE so the next message write fails for real.
    await rm(messagesDir, { recursive: true, force: true })
    await writeFile(messagesDir, 'not a directory', 'utf8')
    const failed = await store.postMessage(room.data.id, { text: 'doomed' })
    expect(failed.ok).toBe(false)
    // Restore the path: the chain must accept the next write.
    await rm(messagesDir, { force: true })
    await mkdir(messagesDir, { recursive: true })
    const recovered = await store.postMessage(room.data.id, { text: 'after failure' })
    expect(recovered.ok).toBe(true)
    if (recovered.ok) expect(recovered.data?.seq).toBeGreaterThanOrEqual(1)
    const persisted = await store.readMessages(room.data.id, { limit: 50 })
    expect(persisted.data?.map(message => message.text)).toEqual(['after failure'])
  })

  it('different rooms stay independent and do not share a counter', async () => {
    const a = await store.createRoom({ title: 'room a' })
    if (!a.ok) throw new Error(a.error)
    const b = await store.createRoom({ title: 'room b' })
    if (!b.ok) throw new Error(b.error)
    const [first, second] = await Promise.all([
      store.postMessage(a.data.id, { text: 'to a' }),
      store.postMessage(b.data.id, { text: 'to b' }),
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    // A shared/global counter would hand out 1 and 2 here.
    expect([first.ok ? first.data?.seq : -1, second.ok ? second.data?.seq : -1]).toEqual([1, 1])
    expect((await store.readMessages(a.data.id)).data?.map(message => message.text)).toEqual(['to a'])
    expect((await store.readMessages(b.data.id)).data?.map(message => message.text)).toEqual(['to b'])
  })

  it('drops the per-room chain entry once it drains', async () => {
    const room = await store.createRoom({ title: 'cleanup' })
    if (!room.ok) throw new Error(room.error)
    await store.postMessage(room.data.id, { text: 'one' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const chains = (store as unknown as { roomChains: Map<string, Promise<void>> }).roomChains
    expect(chains.size).toBe(0)
  })
})

// PARENT (Phase 1 audit, B2): DESIGN §2 — "versi lebih baru => read-only mode".
// The older build must neither downgrade the marker nor write anything into a
// state root whose schema it does not understand.
describe('newer state schema is read-only and never downgraded (B2)', () => {
  const NEWER_MARKER = '{\n  "version": 2,\n  "writtenAt": "2030-01-01T00:00:00.000Z"\n}\n'

  async function storeOnNewerSchema(): Promise<CortexStore> {
    await writeFile(join(root, 'schema.json'), NEWER_MARKER, 'utf8')
    const fresh = makeStore()
    expect((await fresh.init()).ok).toBe(true)
    return fresh
  }

  it('init() leaves the newer marker byte-identical and reports read-only', async () => {
    const fresh = await storeOnNewerSchema()
    expect(await readFile(join(root, 'schema.json'), 'utf8')).toBe(NEWER_MARKER)
    const snapshot = await fresh.statusSnapshot()
    expect(snapshot.ok && snapshot.data.readOnly).toBe(true)
    expect(warnings.join(' ')).toContain('read-only')
  })

  it('repeated init() never rewrites the newer marker', async () => {
    const fresh = await storeOnNewerSchema()
    for (let round = 0; round < 3; round += 1) expect((await fresh.init()).ok).toBe(true)
    expect(await readFile(join(root, 'schema.json'), 'utf8')).toBe(NEWER_MARKER)
  })

  it('reads keep working while writes are refused', async () => {
    const fresh = await storeOnNewerSchema()
    expect((await fresh.listEntries({ track: 'user' })).ok).toBe(true)
    expect((await fresh.listTodos()).ok).toBe(true)
    expect((await fresh.listPending()).ok).toBe(true)
    expect((await fresh.listPrompts()).ok).toBe(true)
    expect((await fresh.listJobs()).ok).toBe(true)
    expect((await fresh.logRead({ scope: 'daily' })).ok).toBe(true)
    expect((await fresh.getPrompt('a'.repeat(12))).ok).toBe(true)
    expect((await fresh.statusSnapshot()).ok).toBe(true)
    expect(await fresh.readInjectQueue('sess-1')).toEqual({ sessionId: 'sess-1', items: [], updatedAt: '' })
  })

  it('every write path refuses with the read-only error and mutates nothing', async () => {
    const fresh = await storeOnNewerSchema()
    const before = await treeOf(fresh.root)
    const id = 'a'.repeat(12)
    const attempts: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
      ['addEntry', () => fresh.addEntry({ scope: { track: 'user' }, content: 'x' })],
      ['updateEntry', () => fresh.updateEntry(id, { content: 'x' })],
      ['archiveEntry', () => fresh.archiveEntry(id)],
      ['restoreEntry', () => fresh.restoreEntry(id)],
      ['deleteEntry', () => fresh.deleteEntry(id)],
      ['addTodo', () => fresh.addTodo({ track: 'life', text: 'x' })],
      ['updateTodo', () => fresh.updateTodo(id, { done: true })],
      ['removeTodo', () => fresh.removeTodo(id)],
      ['logAppend', () => fresh.logAppend({ scope: 'daily', text: 'x' })],
      ['addPending', () => fresh.addPending({ kind: 'memory', proposal: { content: 'x' } })],
      ['approvePending', () => fresh.approvePending(id)],
      ['rejectPending', () => fresh.rejectPending(id)],
      ['addPrompt', () => fresh.addPrompt({ title: 't', body: 'b' })],
      ['updatePrompt', () => fresh.updatePrompt(id, { title: 'x' })],
      ['deletePrompt', () => fresh.deletePrompt(id)],
      ['injectPush', () => fresh.injectPush('sess-1', { promptId: id, mode: 'once' })],
      ['injectConsume', () => fresh.injectConsume('sess-1', [id])],
      ['createRoom', () => fresh.createRoom({ title: 'x' })],
      ['joinRoom', () => fresh.joinRoom(id, { label: 'x' })],
      ['postMessage', () => fresh.postMessage(id, { text: 'x' })],
      ['createJob', () => fresh.createJob({ runner: 'r', argv: ['x'], task: 't' })],
      ['updateJob', () => fresh.updateJob(id, { status: 'succeeded' })],
      ['ensureProject', () => fresh.ensureProject(id, {})],
      ['purgeRoot', () => fresh.purgeRoot()],
      ['writeStateFile', () => fresh.writeStateFile(join(fresh.root, 'rooms', 'seam', 'note.txt'), 'x')],
      ['writeStateJson', () => fresh.writeStateJson(join(fresh.root, 'rooms', 'seam', 'row.json'), { x: 1 })],
      ['createBoard', () => fresh.createBoard({ roomId: id, title: 'b' })],
      ['addCard', () => fresh.addCard({ roomId: id, boardId: id, title: 'c' })],
      ['updateCard', () => fresh.updateCard(id, id, id, { status: 'in-progress' })],
      ['addComment', () => fresh.addComment({ roomId: id, boardId: id, cardId: id, text: 'x' })],
      ['deleteCard', () => fresh.deleteCard(id, id, id)],
      ['deleteBoard', () => fresh.deleteBoard(id, id)],
    ]
    for (const [label, attempt] of attempts) {
      const result = await attempt()
      expect(result.ok, label).toBe(false)
      expect(result.error, label).toBe(STATE_READ_ONLY_ERROR)
    }
    expect(await treeOf(fresh.root)).toEqual(before)
  })

  it('the module write seam writes on a supported schema', async () => {
    const noteFile = join(root, 'rooms', 'seam', 'note.txt')
    const written = await store.writeStateFile(noteFile, 'hello')
    expect(written.ok).toBe(true)
    expect(await readFile(noteFile, 'utf8')).toBe('hello')
    const rowFile = join(root, 'rooms', 'seam', 'row.json')
    expect((await store.writeStateJson(rowFile, { a: 1 })).ok).toBe(true)
    expect(JSON.parse(await readFile(rowFile, 'utf8'))).toEqual({ a: 1 })
  })

  it('a supported schema keeps writes working', async () => {
    await writeFile(join(root, 'schema.json'), `{"version":${String(SCHEMA_VERSION)}}`, 'utf8')
    const fresh = makeStore()
    expect((await fresh.init()).ok).toBe(true)
    expect((await fresh.addEntry({ scope: { track: 'user' }, content: 'after v1' })).ok).toBe(true)
    expect((await fresh.addTodo({ track: 'life', text: 'still writable' })).ok).toBe(true)
  })

  it('a missing marker is scaffolded at this build version and stays writable', async () => {
    await rm(join(root, 'schema.json'), { force: true })
    const fresh = makeStore()
    expect((await fresh.init()).ok).toBe(true)
    expect(JSON.parse(await readFile(join(root, 'schema.json'), 'utf8')).version).toBe(SCHEMA_VERSION)
    expect((await fresh.addEntry({ scope: { track: 'global' }, content: 'writable' })).ok).toBe(true)
  })
})

async function treeOf(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(`${rel}/`, ...await treeOf(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}
