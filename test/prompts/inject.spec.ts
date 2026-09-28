import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as promptsModule from '../../src/host/modules/prompts/index.ts'
import { PROMPTS_CONTEXT_NAME, PROMPTS_CONTEXT_ORDER } from '../../src/host/modules/prompts/service.ts'
import { PROMPTS_BLOCK_CHARS, PROMPT_BODY_CHARS, STICKY_MAX_TURNS } from '../../src/host/modules/prompts/queue.ts'
import { INJECT_LABEL } from '../../src/host/config.ts'
import { hasBracePair } from '../../src/lib/sanitize.ts'
import { callEndpoint, fakeAgent, makeHarness, renderPromptsContext, runTool, saveDoc, settle } from './helpers.ts'
import type { Harness } from './helpers.ts'

/**
 * The injection queue, end to end: `cortex_prompt_inject` / `inject.now` write
 * it, the `cortex:prompts` seam reads and spends it, and the file under
 * `inject/<sessionId>.json` is what a restart survives.
 *
 * The two behaviours worth the most here are the ones the brief calls out:
 * a round is charged ONLY when text actually reached the assembly (a disabled
 * config, a missing agent, a dropped-by-budget entry or a tool read all leave
 * the counter where it was), and a sticky row cannot outlive its window — after
 * `STICKY_MAX_TURNS` renders it gets one honest expiry line and is cleared.
 */

let harness: Harness

beforeEach(async () => {
  harness = await makeHarness()
})

afterEach(async () => {
  promptsModule.disposePrompts()
  await harness.cleanup()
})

const AGENT = 'session-1'
const agent = () => fakeAgent(AGENT)
const render = () => renderPromptsContext(harness.fake, { agent: agent() })

describe('module face', () => {
  it('exports the wiring contract and the frozen seam identity', () => {
    expect(promptsModule.name).toBe('prompts')
    expect([...promptsModule.TOOLS]).toEqual(['cortex_prompt_list', 'cortex_prompt_get', 'cortex_prompt_save', 'cortex_prompt_toggle', 'cortex_prompt_inject'])
    expect(typeof promptsModule.apply).toBe('function')
    expect(harness.fake.contexts.map(entry => entry.name)).toEqual([PROMPTS_CONTEXT_NAME])
    expect(PROMPTS_CONTEXT_NAME).toBe('cortex:prompts')
    expect(PROMPTS_CONTEXT_ORDER).toBe(43)
    expect(harness.fake.contexts[0]?.order).toBe(43)
  })

  it('a second mount on the same host context is idempotent, not a duplicate-name throw', () => {
    // The host throws on a repeat `context(name)`, so a re-apply (hot reload, a
    // second wiring pass) must reuse the registration it already owns.
    const before = harness.fake.contexts.length
    expect(() => promptsModule.apply(harness.deps)).not.toThrow()
    expect(harness.fake.contexts).toHaveLength(before)
    expect(harness.warnings.join('\n')).not.toContain('refused')
  })

  it('a host that refuses the seam costs injection only, never the boot (P4)', async () => {
    const { makeFakeCtx } = await import('./helpers.ts')
    const hostile = makeFakeCtx({ contextThrows: true })
    const deps = { ...harness.deps, ctx: hostile.ctx }
    const svc = new promptsModule.PromptsService(deps)
    svc.install()
    expect(svc.hasContextSeam).toBe(false)
    expect(hostile.contexts).toEqual([])
    expect(harness.warnings.join('\n')).toContain('context registration refused')
    // A refused seam still answers tools and text: the degraded path is live.
    expect(svc.contextText({ agent: fakeAgent('s') })).toBe('')
  })

  it('a profile with no systemPrompt service at all degrades the same way', async () => {
    const { makeFakeCtx } = await import('./helpers.ts')
    const bare = makeFakeCtx({ noSystemPrompt: true })
    const svc = new promptsModule.PromptsService({ ...harness.deps, ctx: bare.ctx })
    svc.install()
    expect(svc.hasContextSeam).toBe(false)
    expect(bare.ctx.get('systemPrompt')).toBeUndefined()
    expect(svc.contextText({ agent: fakeAgent('s') })).toBe('')
  })
})

describe('cortex_prompt_inject: what lands in the queue', () => {
  it('queues a saved prompt and renders it once, then it is gone', async () => {
    const doc = await saveDoc(harness, { title: 'Release checklist', body: '1. tag 2. build 3. publish' })
    const result = await runTool(harness.fake, 'cortex_prompt_inject', { promptId: doc.id, mode: 'once' }, agent())
    expect(result.status).toBe('queued')
    expect(render()).toContain('## Saved workflow: Release checklist (dsh-cortex prompt library — injected on request, 1 rounds left)')
    expect(render()).toBe('')
  })

  it('counts a sticky row down per render and ends it with one honest expiry line', async () => {
    const doc = await saveDoc(harness, { title: 'Standup', body: 'say the three things' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    for (let pass = 1; pass <= STICKY_MAX_TURNS; pass += 1) {
      const text = render()
      expect(text).toContain(`injected on request, ${String(STICKY_MAX_TURNS - pass + 1)} rounds left)`)
      expect(text).toContain('say the three things')
    }
    const expired = render()
    expect(expired).toContain('expired after 25 rounds')
    expect(expired).not.toContain('say the three things')
    expect(render()).toBe('')
    expect(render()).toBe('')
  })

  it('re-injecting restarts the window instead of stacking a second copy', async () => {
    const doc = await saveDoc(harness, { title: 'Deploy', body: 'push it' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    render()
    render()
    const out = await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    expect(out.ok).toBe(true)
    expect((out.rows ?? []).filter(entry => entry.promptId === doc.id)).toHaveLength(1)
    expect(render()).toContain(`injected on request, ${String(STICKY_MAX_TURNS)} rounds left)`)
  })

  it('clear removes what is queued, for one prompt or for the whole session', async () => {
    const a = await saveDoc(harness, { title: 'Alpha', body: 'a text' })
    const b = await saveDoc(harness, { title: 'Beta', body: 'b text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: a.id, mode: 'sticky' })
    await harness.svc.inject({ sessionId: AGENT, promptId: b.id, mode: 'once' })
    const one = await harness.svc.clearQueue(AGENT, a.id)
    expect(one.ok).toBe(true)
    expect((one.rows ?? []).map(entry => entry.promptId)).toEqual([b.id])
    const all = await harness.svc.clearQueue(AGENT)
    expect((all.rows ?? [])).toEqual([])
    expect(render()).toBe('')
  })

  it('refuses an unknown prompt id, a disabled prompt, and both kinds at once', async () => {
    const missing = await harness.svc.inject({ sessionId: AGENT, promptId: 'nope12345678', mode: 'once' })
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('no saved prompt')
    const doc = await saveDoc(harness, { title: 'Off', body: 'text' })
    await harness.svc.toggle(doc.id, false)
    const disabled = await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    expect(disabled.ok).toBe(false)
    expect(disabled.message).toContain('switched off')
    const both = await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, text: 'typed', mode: 'once' })
    expect(both.ok).toBe(false)
    expect(both.message).toContain('not both')
    const neither = await harness.svc.inject({ sessionId: AGENT, mode: 'once' })
    expect(neither.ok).toBe(false)
  })

  it('queues typed text without writing it into the library', async () => {
    const result = await harness.svc.inject({ sessionId: AGENT, mode: 'once', text: 'compare the two files before answering' })
    expect(result.ok).toBe(true)
    expect(await harness.svc.list()).toHaveLength(0)
    const text = render()
    expect(text).toContain('## Saved workflow: manual injection (typed text, not a saved prompt) (dsh-cortex')
    expect(text).toContain('compare the two files before answering')
  })
})

describe('round accounting', () => {
  it('charges a render, and nothing else', async () => {
    const doc = await saveDoc(harness, { title: 'Review', body: 'walk the diff' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    expect(harness.svc.queueFor(AGENT)[0]?.rounds).toBe(STICKY_MAX_TURNS)

    // Reads, proposals and renders for ANOTHER session must not spend a round.
    await runTool(harness.fake, 'cortex_prompt_list', {}, agent())
    await runTool(harness.fake, 'cortex_prompt_get', { id: doc.id }, agent())
    await runTool(harness.fake, 'cortex_prompt_save', { title: 'x', body: 'y' }, agent())
    await harness.svc.inject({ sessionId: 'other-session', promptId: doc.id, mode: 'once' })
    expect(harness.svc.queueFor(AGENT)[0]?.rounds).toBe(STICKY_MAX_TURNS)

    // No agent in the assembly: contribute nothing, charge nothing.
    expect(renderPromptsContext(harness.fake, {})).toBe('')
    expect(renderPromptsContext(harness.fake, { agent: undefined })).toBe('')
    expect(harness.svc.queueFor(AGENT)[0]?.rounds).toBe(STICKY_MAX_TURNS)

    // Two real renders spend exactly two.
    expect(render()).not.toBe('')
    expect(harness.svc.queueFor(AGENT)[0]?.rounds).toBe(STICKY_MAX_TURNS - 1)
    expect(render()).not.toBe('')
    expect(harness.svc.queueFor(AGENT)[0]?.rounds).toBe(STICKY_MAX_TURNS - 2)
  })

  it('charges nothing while prompts or injection are switched off', async () => {
    const doc = await saveDoc(harness, { title: 'Gated', body: 'body text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    const before = harness.svc.queueFor(AGENT)[0]?.rounds
    harness.config.inject = { ...harness.config.inject, enabled: false }
    expect(render()).toBe('')
    harness.config.inject = { ...harness.config.inject, enabled: true }
    harness.config.prompts = { enabled: false }
    expect(render()).toBe('')
    expect(harness.svc.queueFor(AGENT)[0]?.rounds).toBe(before)
    harness.config.prompts = { enabled: true }
    expect(render()).toContain('injected on request')
    expect(harness.svc.queueFor(AGENT)[0]?.rounds).toBe((before ?? 0) - 1)
  })

  it('does not charge an entry the block budget dropped', async () => {
    // Three bodies at the per-render ceiling: only the first fits under 4000,
    // so the other two must keep every round they have left.
    const fat: Array<{ id: string }> = []
    for (const title of ['Fat one', 'Fat two', 'Fat three']) {
      fat.push(await saveDoc(harness, { title, body: 'long body. '.repeat(900) }))
    }
    for (const doc of fat) await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    const text = render()
    expect(text.length).toBeLessThanOrEqual(PROMPTS_BLOCK_CHARS)
    expect(text).toContain('did not fit the block')
    const rows = harness.svc.queueFor(AGENT)
    expect(rows.find(entry => entry.promptId === fat[0]?.id)?.rounds).toBe(STICKY_MAX_TURNS - 1)
    expect(rows.find(entry => entry.promptId === fat[1]?.id)?.rounds).toBe(STICKY_MAX_TURNS)
    expect(rows.find(entry => entry.promptId === fat[2]?.id)?.rounds).toBe(STICKY_MAX_TURNS)
  })
})

describe('queues are per session', () => {
  it('two sessions injecting the same prompt own separate countdowns', async () => {
    const doc = await saveDoc(harness, { title: 'Shared', body: 'both see this' })
    await harness.svc.inject({ sessionId: 'sess-a', promptId: doc.id, mode: 'sticky' })
    await harness.svc.inject({ sessionId: 'sess-b', promptId: doc.id, mode: 'once' })
    expect(harness.svc.renderFor('sess-a')).toContain(`${String(STICKY_MAX_TURNS)} rounds left)`)
    expect(harness.svc.renderFor('sess-b')).toContain('1 rounds left)')
    // A's spend never touches B: B's single round is still owed.
    expect(harness.svc.renderFor('sess-a')).toContain(`${String(STICKY_MAX_TURNS - 1)} rounds left)`)
    expect(harness.svc.renderFor('sess-b')).toBe('')
    expect(harness.svc.queueFor('sess-b')).toEqual([])
    expect(harness.svc.queueFor('sess-a')).toHaveLength(1)
    // and each session's queue is its own file
    await settle(harness.svc)
    expect(existsSync(join(harness.root, 'inject', 'sess-a.json'))).toBe(true)
    expect(existsSync(join(harness.root, 'inject', 'sess-b.json'))).toBe(true)
  })

  it('a session id that sanitizes onto another file does not get its own queue', async () => {
    const doc = await saveDoc(harness, { title: 'Keyed', body: 'text' })
    await harness.svc.inject({ sessionId: 'a/b', promptId: doc.id, mode: 'once' })
    // `a/b` and `a_b` are the same store file, so they are the same queue.
    expect(harness.svc.queueFor('a_b')).toHaveLength(1)
    expect(harness.svc.renderFor('a_b')).toContain('## Saved workflow: Keyed')
  })
})

describe('mount-time warming', () => {
  it('primes the queues of sessions already live, so the first turn is not lost', async () => {
    const doc = await saveDoc(harness, { title: 'Warmed', body: 'ready on turn one' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    await settle(harness.svc)
    // A fresh service on a fresh store, this time with a live session: apply()
    // must warm it, so the very first assembly already carries the text.
    const { CortexStore } = await import('../../src/host/store.ts')
    const fake = (await import('./helpers.ts')).makeFakeCtx()
    const store = new CortexStore({ root: harness.root, caps: () => harness.config.caps, warn: message => harness.warnings.push(message) })
    const agents = { ...fake.ctx.agents, roots: () => [fakeAgent(AGENT)] }
    fake.ctx.agents = agents as never
    const second = new promptsModule.PromptsService({ ...harness.deps, ctx: fake.ctx, store })
    await second.warmLiveSessions()
    await second.flushQueueWrites()
    expect(second.renderFor(AGENT)).toContain('ready on turn one')
    expect(second.renderFor(AGENT)).toBe('')
  })

  it('a hostile roots() answer is reported, not fatal (P4)', async () => {
    const { makeFakeCtx } = await import('./helpers.ts')
    const fake = makeFakeCtx()
    fake.ctx.agents = { get: () => undefined, roots: () => { throw new Error('agents exploded') } } as never
    const svc = new promptsModule.PromptsService({ ...harness.deps, ctx: fake.ctx })
    expect(() => svc.warmLiveSessions()).not.toThrow()
    expect(harness.warnings.join('\n')).toContain('agents.roots() failed')
  })
})

describe('persistence across a restart', () => {
  it('a second store + service over the same root continues the countdown', async () => {
    const doc = await saveDoc(harness, { title: 'Persisted', body: 'survives the reboot' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    render()
    render()
    await settle(harness.svc)
    const onDisk = harness.svc.queueFor(AGENT)[0]?.rounds
    expect(onDisk).toBe(STICKY_MAX_TURNS - 2)

    const reopened = await harness.reopen()
    expect(reopened.queueFor(AGENT)).toEqual([])
    const rows = await reopened.prime(AGENT)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.rounds).toBe(STICKY_MAX_TURNS - 2)
    expect(rows[0]?.title).toBe('Persisted')
    const text = reopened.renderFor(AGENT)
    expect(text).toContain(`injected on request, ${String(STICKY_MAX_TURNS - 2)} rounds left)`)
    expect(reopened.queueFor(AGENT)[0]?.rounds).toBe(STICKY_MAX_TURNS - 3)
  })

  it('drops a queued row whose prompt was deleted, and says so in the log', async () => {
    const doc = await saveDoc(harness, { title: 'Doomed', body: 'text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    await settle(harness.svc)
    const call = await callEndpoint(promptsModule.writeEndpoints, 'prompts.delete', { id: doc.id, confirm: 'DELETE' })
    expect(call.ok).toBe(true)
    const reopened = await harness.reopen()
    expect(await reopened.prime(AGENT)).toEqual([])
    expect(reopened.renderFor(AGENT)).toBe('')
    expect(harness.warnings.join('\n')).toContain('dropped queued injection')
  })

  it('drops a queued row whose library body is empty, instead of a header over nothing', async () => {
    const doc = await saveDoc(harness, { title: 'Hollow', body: 'real text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    await settle(harness.svc)
    // The panel refuses to save a blank body, so empty the library row the way
    // reality would: by editing the state file behind the module's back.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(harness.root, 'prompts', `${doc.id}.json`), JSON.stringify({ ...doc, body: '   ' }), 'utf8')
    const reopened = await harness.reopen()
    expect(await reopened.prime(AGENT)).toEqual([])
    expect(reopened.renderFor(AGENT)).toBe('')
    expect(harness.warnings.join('\n')).toContain('body is empty')
  })

  it('reads a row written in the store shape (no body) by hydrating it from the library', async () => {
    const doc = await saveDoc(harness, { title: 'Store shaped', body: 'hydrated from prompts/' })
    await harness.store.injectPush(AGENT, { promptId: doc.id, mode: 'once' })
    const reopened = await harness.reopen()
    const rows = await reopened.prime(AGENT)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toBe('hydrated from prompts/')
    expect(reopened.renderFor(AGENT)).toContain('hydrated from prompts/')
  })

  it('a corrupt queue file costs that session its queue, nothing more (P4)', async () => {
    const doc = await saveDoc(harness, { title: 'Corrupt', body: 'text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    await settle(harness.svc)
    const file = join(harness.root, 'inject', `${AGENT}.json`)
    expect(existsSync(file)).toBe(true)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{not json', 'utf8')
    const reopened = await harness.reopen()
    expect(await reopened.prime(AGENT)).toEqual([])
    expect(reopened.renderFor(AGENT)).toBe('')
    expect(harness.warnings.join('\n')).toContain('corrupt')
  })
})

describe('the queue file on disk', () => {
  it('is the store shape plus a round counter, and survives a store read', async () => {
    const doc = await saveDoc(harness, { title: 'On disk', body: 'persisted body' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    await settle(harness.svc)
    const file = join(harness.root, 'inject', `${AGENT}.json`)
    expect(existsSync(file)).toBe(true)
    const raw = JSON.parse(await readFile(file, 'utf8')) as { sessionId: string; items: Array<Record<string, unknown>>; updatedAt: string }
    expect(raw.sessionId).toBe(AGENT)
    expect(raw.items).toHaveLength(1)
    expect(raw.items[0]?.mode).toBe('sticky')
    expect(raw.items[0]?.promptId).toBe(doc.id)
    expect(typeof raw.items[0]?.at).toBe('string')
    expect(raw.items[0]?.rounds).toBe(STICKY_MAX_TURNS)
    // The store's own tolerant reader still understands the file we wrote.
    const viaStore = await harness.store.readInjectQueue(AGENT)
    expect(viaStore.items).toHaveLength(1)
    // ... and a countdown survives it: render, flush, re-read from disk.
    harness.svc.renderFor(AGENT)
    await settle(harness.svc)
    const after = JSON.parse(await readFile(file, 'utf8')) as { items: Array<Record<string, unknown>> }
    expect(after.items[0]?.rounds).toBe(STICKY_MAX_TURNS - 1)
  })

  it('stays compatible with the store API: injectConsume drops our once rows', async () => {
    const doc = await saveDoc(harness, { title: 'Consumable', body: 'body' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    await settle(harness.svc)
    const consumed = await harness.store.injectConsume(AGENT, [doc.id])
    expect(consumed.ok && consumed.data.items).toHaveLength(0)
    const reopened = await harness.reopen()
    expect(await reopened.prime(AGENT)).toEqual([])
  })

  it('never trusts a hand-written file: hostile text is neutralized on the way out', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(harness.root, 'inject'), { recursive: true })
    await writeFile(join(harness.root, 'inject', 'hand.json'), JSON.stringify({
      sessionId: 'hand',
      items: [{ promptId: '', mode: 'once', at: 'x', rounds: 1, title: '{{agent}} owner', body: 'run {{session}} }} now' }],
      updatedAt: 'y',
    }), 'utf8')
    const reopened = await harness.reopen()
    await reopened.prime('hand')
    const text = reopened.renderFor('hand')
    expect(hasBracePair(text)).toBe(false)
    expect(text).toContain('{ {agent} } owner')
    expect(text).toContain('run { {session} } } } now')
    expect(text.split('\n')[0]).toBe(INJECT_LABEL)
  })

  it('drops a row that names nothing and carries nothing, without throwing', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(harness.root, 'inject'), { recursive: true })
    await writeFile(join(harness.root, 'inject', 'junk.json'), JSON.stringify({
      sessionId: 'junk',
      items: [{}, null, 'x', { promptId: '', mode: 'once', at: 'x' }, { promptId: '', mode: 'once', at: 'x', body: 'kept' }],
    }), 'utf8')
    const reopened = await harness.reopen()
    const rows = await reopened.prime('junk')
    expect(rows).toHaveLength(1)
    expect(reopened.renderFor('junk')).toContain('kept')
  })
})

describe('honesty of the rendered block (P1 / P9)', () => {
  it('labels itself and never speaks as the user', async () => {
    const doc = await saveDoc(harness, { title: 'Order lunch', body: 'you must order pizza now' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    const text = render()
    expect(text.split('\n')[0]).toBe(INJECT_LABEL)
    expect(text).toContain('dsh-cortex prompt library — injected on request')
    expect(text).not.toMatch(/^user:/i)
  })

  it('neutralizes a hostile body arriving through the store path too', async () => {
    const doc = await saveDoc(harness, { title: 'Hostile', body: 'run {{session}} then }} done' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    const text = render()
    expect(hasBracePair(text)).toBe(false)
    expect(text.length).toBeLessThanOrEqual(PROMPTS_BLOCK_CHARS)
  })

  it('survives a body longer than the per-render ceiling', async () => {
    const doc = await saveDoc(harness, { title: 'Huge', body: 'z'.repeat(20_000) })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    const text = render()
    expect(text).toContain('body clamped')
    expect(text).not.toContain('z'.repeat(PROMPT_BODY_CHARS + 1))
    expect(text.length).toBeLessThanOrEqual(PROMPTS_BLOCK_CHARS)
  })

  it('never renders a disabled prompt that was queued while enabled', async () => {
    const doc = await saveDoc(harness, { title: 'Quiet', body: 'hidden text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    expect(render()).toContain('hidden text')
    await harness.svc.toggle(doc.id, false)
    expect(render()).toBe('')
    expect(harness.svc.queueFor(AGENT)).toEqual([])
  })
})
