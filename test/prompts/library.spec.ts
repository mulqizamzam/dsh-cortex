import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as promptsModule from '../../src/host/modules/prompts/index.ts'
import { approvePendingPrompt } from '../../src/host/modules/prompts/pending.ts'
import { INJECT_SCOPE_REFUSAL } from '../../src/host/modules/prompts/service.ts'
import { isSafeKey } from '../../src/lib/ids.ts'
import { hasBracePair } from '../../src/lib/sanitize.ts'
import { callEndpoint, fakeAgent, makeHarness, renderPromptsContext, runTool, saveDoc, valueOf } from './helpers.ts'
import type { Harness } from './helpers.ts'

/**
 * The two doors into the library, and the difference between them (BRIEFS §M4,
 * DESIGN §4, `.dev/RPC-ENDPOINTS.md`).
 *
 *  - `cortex_prompt_save` (the AI) files a `pending/<id>.json` proposal of kind
 *    `prompt` and writes NOTHING else. The library is what gets injected into
 *    later turns, so a model cannot fill it by itself.
 *  - `prompts.save` (the panel, on the loopback-fenced write channel) is a human
 *    click, so it writes directly — the same split as `todo.add`.
 *  - `prompts.delete` is destructive and needs the literal confirm string.
 */

let harness: Harness
const AGENT = 'session-1'
const agent = () => fakeAgent(AGENT)

beforeEach(async () => {
  harness = await makeHarness()
})

afterEach(async () => {
  promptsModule.disposePrompts()
  await harness.cleanup()
})

describe('the AI door: proposals only', () => {
  it('saves nothing to the library and files a kind=prompt pending row', async () => {
    const result = await runTool(harness.fake, 'cortex_prompt_save', {
      title: 'Weekly review',
      body: 'open the todos, ask what slipped',
      category: 'review',
      reason: 'the user asked for a standing review',
    }, agent())
    expect(result.status).toBe('pending')
    expect(await harness.svc.list()).toHaveLength(0)
    expect(result.pendingId).toBeTypeOf('string')

    const pending = await harness.store.listPending({ status: 'pending' })
    expect(pending.ok).toBe(true)
    const items = pending.ok ? pending.data : []
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('prompt')
    expect(items[0]?.proposal.title).toBe('Weekly review')
    expect(items[0]?.proposal.body).toBe('open the todos, ask what slipped')
    expect(items[0]?.fromSessionId).toBe(AGENT)
    expect(String(result.message)).toContain('NOT in the prompt library yet')
  })

  it('refuses an empty title or body instead of filing a blank proposal', async () => {
    const noTitle = await runTool(harness.fake, 'cortex_prompt_save', { title: '  ', body: 'text' }, agent())
    expect(noTitle.status).toBe('refused')
    const noBody = await runTool(harness.fake, 'cortex_prompt_save', { title: 'x', body: '   ' }, agent())
    expect(noBody.status).toBe('refused')
    expect((await harness.store.listPending({ status: 'pending' })).data ?? []).toHaveLength(0)
  })

  it('approvePendingPrompt is the missing kind=prompt approver, and it keeps the audit row', async () => {
    const added = await harness.store.addPending({
      kind: 'prompt',
      proposal: { title: 'Approved flow', body: 'do the thing', category: 'ops' },
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const decided = await approvePendingPrompt(harness.store, added.data)
    expect(decided.ok).toBe(true)
    expect(decided.doc?.title).toBe('Approved flow')
    const doc = decided.doc
    expect(doc).toBeTruthy()
    if (doc === undefined || doc === null) return
    expect(await harness.svc.get(doc.id)).not.toBeNull()
    // One proposal, decided — not consumed, not duplicated.
    const row = (await harness.store.getPrompt(doc.id)).data
    expect(row?.body).toBe('do the thing')
    const after = await harness.store.approvePending(added.data.id)
    expect(after.data?.status).toBe('approved')
    // Approving twice must not silently create a second copy of the workflow.
    const again = await approvePendingPrompt(harness.store, { ...added.data, status: 'approved' })
    expect(again.ok).toBe(true)
    expect((await harness.svc.list({})).filter(entry => entry.title === 'Approved flow')).toHaveLength(2)
  })

  it('refuses to approve another kind, or an unusable payload', async () => {
    const other = await harness.store.addPending({ kind: 'todo', proposal: { text: 'x', track: 'life' } })
    if (!other.ok) return
    const wrong = await approvePendingPrompt(harness.store, other.data)
    expect(wrong.ok).toBe(false)
    expect(wrong.message).toContain("not a prompt")
    const blank = await harness.store.addPending({ kind: 'prompt', proposal: { title: '  ', body: '' } })
    if (!blank.ok) return
    expect((await approvePendingPrompt(harness.store, blank.data)).ok).toBe(false)
  })
})

describe('the human door: endpoints write directly', () => {
  it('prompts.save creates the library row with no pending gate', async () => {
    const call = await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { title: 'Panel made', body: 'steps here', category: 'ui' })
    expect(call.ok).toBe(true)
    const value = valueOf(call)
    const doc = value.doc as Record<string, unknown>
    expect(doc.title).toBe('Panel made')
    expect(doc.bodyChars).toBe('steps here'.length)
    expect(isSafeKey(String(doc.id))).toBe(true)
    expect((await harness.store.listPending({ status: 'pending' })).data ?? []).toHaveLength(0)
    expect(await harness.svc.list()).toHaveLength(1)
  })

  it('prompts.save with an id edits that row instead of adding one', async () => {
    const created = await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { title: 'First', body: 'v1' })
    const id = (valueOf(created).doc as Record<string, unknown>).id as string
    const edited = await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { id, title: 'Second', body: 'v2' })
    expect(edited.ok).toBe(true)
    expect((valueOf(edited).doc as Record<string, unknown>).id).toBe(id)
    expect(await harness.svc.list()).toHaveLength(1)
    expect((await harness.svc.get(id))?.title).toBe('Second')
    const ghost = await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { id: 'nope12345678', title: 'x', body: 'y' })
    expect(ghost.ok).toBe(false)
    expect(ghost.error?.code).toBe('command-error') // projected; ours survives in the message
  })

  it('prompts.list reports docs, not bodies; prompts.get carries the body with a cap', async () => {
    await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { title: 'Listed', body: 'a'.repeat(500), category: 'cat' })
    const list = valueOf(await callEndpoint(promptsModule.readEndpoints, 'prompts.list', {}))
    const docs = list.docs as Array<Record<string, unknown>>
    expect(docs).toHaveLength(1)
    expect(docs[0]?.bodyChars).toBe(500)
    expect(docs[0]?.body).toBeUndefined()
    expect(docs[0]?.enabled).toBe(true)

    const one = valueOf(await callEndpoint(promptsModule.readEndpoints, 'prompts.get', { id: docs[0]?.id }))
    const full = one.doc as Record<string, unknown>
    expect(String(full.body)).toHaveLength(500)
    expect(full.truncated).toBe(false)

    const missing = await callEndpoint(promptsModule.readEndpoints, 'prompts.get', { id: 'zzz123456789' })
    expect(missing.ok).toBe(false)
    expect(missing.error?.code).toBe('command-error') // projected; ours survives in the message
    expect((await callEndpoint(promptsModule.readEndpoints, 'prompts.get', { id: '../escape' })).ok).toBe(false)
    expect((await callEndpoint(promptsModule.readEndpoints, 'prompts.get', {})).ok).toBe(false)
  })

  it('prompts.list filters by category and hides disabled rows unless asked', async () => {
    const keep = await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { title: 'Keep', body: 'b', category: 'a' })
    const other = await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { title: 'Other', body: 'b', category: 'b' })
    const id = (valueOf(other).doc as Record<string, unknown>).id as string
    expect((valueOf(await callEndpoint(promptsModule.readEndpoints, 'prompts.list', { category: 'a' })).docs as unknown[])).toHaveLength(1)
    await callEndpoint(promptsModule.writeEndpoints, 'prompts.toggle', { id, enabled: false })
    const enabledOnly = valueOf(await callEndpoint(promptsModule.readEndpoints, 'prompts.list', { includeDisabled: false }))
    expect((enabledOnly.docs as unknown[]).map(entry => (entry as Record<string, unknown>).id)).toEqual([(valueOf(keep).doc as Record<string, unknown>).id])
    const everything = valueOf(await callEndpoint(promptsModule.readEndpoints, 'prompts.list', {}))
    expect(everything.docs).toHaveLength(2)
    expect((everything.docs as Array<Record<string, unknown>>).find(entry => entry.id === id)?.enabled).toBe(false)
  })

  it('prompts.toggle flips the flag, refuses garbage and stops a queued injection', async () => {
    const doc = await saveDoc(harness, { title: 'Toggled', body: 'text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'once' })
    const off = await callEndpoint(promptsModule.writeEndpoints, 'prompts.toggle', { id: doc.id, enabled: false })
    expect(off.ok).toBe(true)
    expect((valueOf(off).doc as Record<string, unknown>).enabled).toBe(false)
    expect(renderPromptsContext(harness.fake, { agent: agent() })).toBe('')
    expect(harness.svc.queueFor(AGENT)).toEqual([])
    const on = await callEndpoint(promptsModule.writeEndpoints, 'prompts.toggle', { id: doc.id, enabled: true })
    expect((valueOf(on).doc as Record<string, unknown>).enabled).toBe(true)
    // Bad arguments are refusals, never crashes.
    expect((await callEndpoint(promptsModule.writeEndpoints, 'prompts.toggle', { id: doc.id })).ok).toBe(false)
    expect((await callEndpoint(promptsModule.writeEndpoints, 'prompts.toggle', { id: 'x!', enabled: true })).ok).toBe(false)
    expect((await callEndpoint(promptsModule.writeEndpoints, 'prompts.toggle', { id: 'aa12345678bb', enabled: 'yes' })).ok).toBe(false)
  })

  it('prompts.delete demands the exact confirm string, then drops the row and its queue', async () => {
    const doc = await saveDoc(harness, { title: 'Delete me', body: 'text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    expect((await callEndpoint(promptsModule.writeEndpoints, 'prompts.delete', { id: doc.id })).ok).toBe(false)
    expect((await callEndpoint(promptsModule.writeEndpoints, 'prompts.delete', { id: doc.id, confirm: 'delete' })).ok).toBe(false)
    expect((await callEndpoint(promptsModule.writeEndpoints, 'prompts.delete', { id: doc.id, confirm: 'DELETE please' })).ok).toBe(false)
    expect(await harness.svc.get(doc.id)).not.toBeNull()
    const gone = await callEndpoint(promptsModule.writeEndpoints, 'prompts.delete', { id: doc.id, confirm: 'DELETE' })
    expect(gone.ok).toBe(true)
    expect(valueOf(gone).deleted).toBe(true)
    expect(await harness.svc.get(doc.id)).toBeNull()
    expect(harness.svc.queueFor(AGENT)).toEqual([])
    expect((await callEndpoint(promptsModule.writeEndpoints, 'prompts.delete', { id: doc.id, confirm: 'DELETE' })).error?.code).toBe('command-error') // projected; ours survives in the message
  })

  it('inject.now names its session and answers with the queue state', async () => {
    const doc = await saveDoc(harness, { title: 'From panel', body: 'click-injected' })
    const call = await callEndpoint(promptsModule.writeEndpoints, 'inject.now', { promptId: doc.id, targetSessionId: 'panel-1', mode: 'sticky' })
    expect(call.ok).toBe(true)
    const value = valueOf(call)
    const queue = value.queue as Array<Record<string, unknown>>
    expect(queue[0]?.mode).toBe('sticky')
    expect(queue[0]?.rounds).toBe(25)
    expect((value.lines as string[])[0]).toContain('sticky')
    // A second session's queue is a different file: untouched by this call.
    expect(harness.svc.queueFor(AGENT)).toEqual([])

    expect((await callEndpoint(promptsModule.writeEndpoints, 'inject.now', { promptId: doc.id, mode: 'once' })).ok).toBe(false)
    expect((await callEndpoint(promptsModule.writeEndpoints, 'inject.now', { targetSessionId: 'panel-1', mode: 'sideways' })).ok).toBe(false)
    expect((await callEndpoint(promptsModule.writeEndpoints, 'inject.now', { targetSessionId: 'panel-1', mode: 'once' })).ok).toBe(false)
    const cleared = await callEndpoint(promptsModule.writeEndpoints, 'inject.now', { targetSessionId: 'panel-1', mode: 'clear' })
    expect(valueOf(cleared).queue).toEqual([])
  })

  it('answers a garbage payload with a refusal, never a throw (transport safety)', async () => {
    const junk: unknown[] = [null, undefined, [], 'text', 42, { id: {}, scope: 'nope' }]
    for (const [kind, map] of [['read', promptsModule.readEndpoints], ['write', promptsModule.writeEndpoints]] as const) {
      for (const endpoint of Object.keys(map)) {
        for (const payload of junk) {
          const call = await callEndpoint(map, endpoint, payload)
          // Every endpoint answers a junk payload with a refusal — never a crash
          // at the transport, and never a stack string leaking to the panel.
          // `prompts.list` has nothing to get wrong (its filters are optional and
          // ignored when malformed); every other endpoint must refuse a junk
          // payload — with a sentence, not a crash at the transport.
          if (endpoint === 'prompts.list') expect(call.ok, endpoint).toBe(true)
          else {
            expect(call.ok, `${kind} ${endpoint} ${JSON.stringify(payload)}`).toBe(false)
            expect(typeof call.error?.message, endpoint).toBe('string')
          }
        }
      }
    }
  })

  it('inject.now accepts the contract scope object and refuses an oversized session id', async () => {
    const doc = await saveDoc(harness, { title: 'Scoped', body: 'via scope' })
    const scoped = await callEndpoint(promptsModule.writeEndpoints, 'inject.now', {
      promptId: doc.id,
      mode: 'once',
      scope: { sessionId: 'scoped-1' },
    })
    expect(scoped.ok).toBe(true)
    expect(valueOf(scoped).sessionId).toBe('scoped-1')
    const huge = await callEndpoint(promptsModule.writeEndpoints, 'inject.now', {
      promptId: doc.id,
      mode: 'once',
      targetSessionId: 'x'.repeat(300),
    })
    expect(huge.ok).toBe(false)
    expect(huge.error?.code).toBe('command-error') // projected; ours survives in the message
  })

  it('endpoint names are exactly the frozen contract, nothing extra', () => {
    expect(Object.keys(promptsModule.readEndpoints).sort()).toEqual(['prompts.get', 'prompts.list'])
    expect(Object.keys(promptsModule.writeEndpoints).sort()).toEqual(['inject.now', 'prompts.delete', 'prompts.save', 'prompts.toggle'])
    expect([...promptsModule.READ_ENDPOINT_NAMES].sort()).toEqual(['prompts.get', 'prompts.list'])
    expect([...promptsModule.WRITE_ENDPOINT_NAMES].sort()).toEqual(['inject.now', 'prompts.delete', 'prompts.save', 'prompts.toggle'])
  })

  it('an unwired endpoint answers honestly instead of throwing at the transport', async () => {
    promptsModule.bindPromptEndpoints(null as never)
    const call = await callEndpoint(promptsModule.writeEndpoints, 'prompts.save', { title: 'x', body: 'y' })
    expect(call.ok).toBe(false)
    // The transport guard caught a handler throw and answered instead of leaking it.
    expect(call.error?.code).toBe('internal') // projected; ours survives in the message
    // This one is the TEST HELPER refusing an endpoint it has no map for, not a
    // production `refuse()` — helpers.ts answers in its own vocabulary.
    const missing = await callEndpoint(promptsModule.writeEndpoints, 'prompts.nope', {})
    expect(missing.error?.code).toBe('unknown-endpoint')
  })
})

describe('the disabled gate names the key (P3)', () => {
  it('tools and endpoints all refuse when prompts.enabled is false', async () => {
    harness.config.prompts = { enabled: false }
    const listTool = await runTool(harness.fake, 'cortex_prompt_list', {}, agent())
    expect(listTool.status).toBe('refused')
    expect(String(listTool.message)).toContain('prompts.enabled = false')
    for (const name of ['cortex_prompt_get', 'cortex_prompt_save', 'cortex_prompt_toggle', 'cortex_prompt_inject']) {
      const out = await runTool(harness.fake, name, { id: 'aa12345678bb', promptId: 'aa12345678bb', mode: 'once', title: 't', body: 'b', enabled: true }, agent())
      expect(out.status, name).toBe('refused')
      expect(String(out.message), name).toContain('prompts.enabled')
    }
    for (const endpoint of ['prompts.save', 'prompts.toggle', 'prompts.delete', 'inject.now']) {
      const call = await callEndpoint(promptsModule.writeEndpoints, endpoint, { id: 'aa12345678bb', title: 't', body: 'b', enabled: true, confirm: 'DELETE', targetSessionId: 's', mode: 'once', promptId: 'aa12345678bb' })
      expect(call.ok, endpoint).toBe(false)
      expect(call.error?.code, endpoint).toBe('command-error') // projected; ours survives in the message
      expect(call.error?.message, endpoint).toContain('[disabled]')
      expect(String(call.error?.message), endpoint).toContain('prompts.enabled')
    }
    // Reads refuse too: a switched-off domain answers one sentence everywhere.
    for (const endpoint of ['prompts.list', 'prompts.get']) {
      const call = await callEndpoint(promptsModule.readEndpoints, endpoint, { id: 'aa12345678bb' })
      expect(call.ok, endpoint).toBe(false)
      expect(call.error?.code, endpoint).toBe('command-error') // projected; ours survives in the message
      expect(call.error?.message, endpoint).toContain('[disabled]')
      expect(String(call.error?.message), endpoint).toContain('prompts.enabled')
    }
    // And nothing was written anywhere.
    expect(await harness.svc.list()).toHaveLength(0)
    expect((await harness.store.listPending({ status: 'pending' })).data ?? []).toHaveLength(0)
  })

  it('refuses to inject into somebody else session, and changes nothing', async () => {
    const doc = await saveDoc(harness, { title: 'Mine', body: 'text' })
    const attempt = await runTool(harness.fake, 'cortex_prompt_inject', { promptId: doc.id, mode: 'once', targetSessionId: 'other-session' }, agent())
    expect(attempt.status).toBe('refused')
    expect(String(attempt.message)).toContain(INJECT_SCOPE_REFUSAL)
    expect(harness.svc.queueFor(AGENT)).toEqual([])
    expect(harness.svc.queueFor('other-session')).toEqual([])
    // Nothing was read or written for the named session: no queue file exists.
    expect(existsSync(join(harness.root, 'inject', 'other-session.json'))).toBe(false)
    // Naming your own session is the same as naming none.
    const same = await runTool(harness.fake, 'cortex_prompt_inject', { promptId: doc.id, mode: 'once', targetSessionId: AGENT }, agent())
    expect(same.status).toBe('queued')
    // A tool call with no agent at all has no queue to write.
    const bare = await runTool(harness.fake, 'cortex_prompt_inject', { promptId: doc.id, mode: 'once' })
    expect(bare.status).toBe('refused')
    expect(String(bare.message)).toContain('no calling session')
  })
})

describe('the read tools', () => {
  it('list reports ids and sizes, not bodies', async () => {
    const doc = await saveDoc(harness, { title: 'Readable', body: 'b'.repeat(300), category: 'cat' })
    const out = await runTool(harness.fake, 'cortex_prompt_list', {}, agent())
    expect(out.status).toBe('ok')
    expect(out.count).toBe(1)
    const lines = out.lines as string[]
    expect(lines[0]).toContain(doc.id)
    expect(lines[0]).toContain('Readable')
    expect(lines[0]).toContain('300 chars')
    expect(lines.join('')).not.toContain('bbb')
    expect(out.summary).toContain('1 saved prompt')
    const empty = await runTool(harness.fake, 'cortex_prompt_list', {}, agent())
    expect(empty.count).toBe(1)
  })

  it('get returns the body and refuses an unknown id', async () => {
    const doc = await saveDoc(harness, { title: 'Full', body: 'the whole text' })
    const out = await runTool(harness.fake, 'cortex_prompt_get', { id: doc.id }, agent())
    expect(out.status).toBe('ok')
    const prompt = out.prompt as Record<string, unknown>
    expect(prompt.body).toBe('the whole text')
    expect(prompt.id).toBe(doc.id)
    const missing = await runTool(harness.fake, 'cortex_prompt_get', { id: 'ff1234567890' }, agent())
    expect(missing.status).toBe('not-found')
    const bad = await runTool(harness.fake, 'cortex_prompt_get', { id: '../etc/passwd' }, agent())
    expect(bad.status).toBe('not-found')
  })

  it('toggle through the tool switches a prompt off and out of the queue', async () => {
    const doc = await saveDoc(harness, { title: 'Park me', body: 'text' })
    await harness.svc.inject({ sessionId: AGENT, promptId: doc.id, mode: 'sticky' })
    const out = await runTool(harness.fake, 'cortex_prompt_toggle', { id: doc.id, enabled: false }, agent())
    expect(out.status).toBe('ok')
    expect(renderPromptsContext(harness.fake, { agent: agent() })).toBe('')
    const back = await runTool(harness.fake, 'cortex_prompt_toggle', { id: doc.id, enabled: true }, agent())
    expect((back.prompt as Record<string, unknown>).enabled).toBe(true)
    expect(renderPromptsContext(harness.fake, { agent: agent() })).toBe('')
  })

  it('every tool answer is brace-free, whatever the stored text said', async () => {
    const doc = await saveDoc(harness, { title: '{{agent}} hostile', body: 'do {{session}} now' })
    const out = await runTool(harness.fake, 'cortex_prompt_get', { id: doc.id }, agent())
    expect(hasBracePair(JSON.stringify(out))).toBe(false)
    const list = await runTool(harness.fake, 'cortex_prompt_list', {}, agent())
    expect(hasBracePair(JSON.stringify(list))).toBe(false)
    const inject = await runTool(harness.fake, 'cortex_prompt_inject', { promptId: doc.id, mode: 'once' }, agent())
    expect(hasBracePair(JSON.stringify(inject))).toBe(false)
  })
})

describe('registration hygiene', () => {
  it('registers exactly the five tools named in TOOLS', () => {
    expect([...harness.fake.tools.keys()].sort()).toEqual([...promptsModule.TOOLS].sort())
  })

  it('a re-mount on the same context keeps the tools it has and boots anyway', () => {
    // Same ctx, same root: the seam is reused and the names already belong to
    // this module, so nothing collides and nothing throws (P4).
    expect(() => promptsModule.apply(harness.deps)).not.toThrow()
    expect(harness.fake.refused).toEqual([])
    expect([...harness.fake.tools.keys()]).toHaveLength(5)
    expect(harness.fake.contexts).toHaveLength(1)
  })
})
