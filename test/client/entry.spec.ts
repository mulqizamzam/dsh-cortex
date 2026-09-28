// @vitest-environment node
/**
 * The client entry: what `apply(rawContext)` mounts, and what it does when the
 * context is wrong. The rules under test are the crash-trap rules
 * (`docs/HOST-API.md` §9.5, P4): `register()` throws on an undeclared slot and
 * on a priority collision, and NEITHER may reach the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_ID,
  PANEL_ORDER,
  apply,
  cortexMountFailures,
  inject,
  resetCortexMountFailures,
  senderFrom,
  scopeSource,
} from '../../src/client/index.ts'
import { SETTINGS_CARD_ID, SETTINGS_CARD_ORDER } from '../../src/client/settings.ts'
import { createCortexApi } from '../../src/client/api.ts'
import { createMockTransport } from '../../src/client/mock-adapter.ts'

interface Registered {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

/** A slots service with the host's real failure modes available on demand. */
function fakeSlots(options: { throwOn?: string; declared?: string[] } = {}) {
  const registered: Registered[] = []
  const injected: string[] = []
  const slots = {
    inject(name: string, build: () => unknown): unknown {
      injected.push(name)
      if (options.declared !== undefined && !options.declared.includes(name)) {
        // The host's own `inject` is a no-op for an undeclared slot; register
        // is the call that throws. Run the factory anyway to prove the guard.
        build()
        return undefined
      }
      const disposer = build()
      return typeof disposer === 'function' ? disposer : undefined
    },
    register(overrides: Record<string, unknown>, component: unknown): () => void {
      const name = String(overrides.name ?? '')
      if (options.throwOn !== undefined && options.throwOn === name) {
        throw new Error(`slot "${name}" is not declared (a parent entry's children table must declare it)`)
      }
      registered.push({ slot: name, options: overrides, component })
      return () => {}
    },
  }
  return { slots, registered, injected }
}

type CallSpy = (channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<unknown>

/**
 * The host seams, faithful to cordis, for the lifecycle assertions below.
 *
 * Two behaviours the plain fakes above cannot model, and that the whole
 * mount/unmount contract rests on:
 *
 *   - `ctx.effect(execute, label)` CALLS `execute` immediately and registers
 *     whatever it RETURNS as the teardown. A recorder that never invokes the
 *     body cannot tell "registered a disposer" from "passed a disposer as if it
 *     were a disposer" — the two differ by whether the teardown is deferred to
 *     fiber unload or has already run.
 *   - `slots.register(...)` returns a disposer that really removes the entry
 *     from the ledger, and `slots.inject(...)` returns one that really removes
 *     the contribution it installed.
 *
 * @returns the fake context plus an `unload()` that runs the collected teardowns
 * in reverse registration order, as a fiber does.
 */
function cordisHarness() {
  const ledger: Registered[] = []
  const teardowns: Array<[() => void, string | undefined]> = []
  const slots = {
    inject(name: string, build: () => unknown): () => void {
      const inner = build()
      if (typeof inner !== 'function') return () => {}
      const entry = ledger[ledger.length - 1]
      return () => {
        const at = ledger.indexOf(entry)
        if (at >= 0) ledger.splice(at, 1)
        ;(inner as () => void)()
      }
    },
    register(overrides: Record<string, unknown>, component: unknown): () => void {
      const entry: Registered = { slot: String(overrides.name ?? ''), options: overrides, component }
      ledger.push(entry)
      return () => {
        const at = ledger.indexOf(entry)
        if (at >= 0) ledger.splice(at, 1)
      }
    },
  }
  const ctx = {
    slots,
    ...fakeConnection().connection,
    effect(body: () => (() => void) | void, label?: string): void {
      const disposer = body()
      if (typeof disposer === 'function') teardowns.push([disposer, label])
    },
  }
  return {
    ctx,
    ledger,
    labels: () => teardowns.map(([, label]) => label),
    unload(): void {
      for (const [disposer] of [...teardowns].reverse()) disposer()
      teardowns.length = 0
    },
  }
}

function fakeConnection(impl?: CallSpy) {
  const spy = vi.fn(impl ?? (async () => ({ ok: true, value: {} })))
  return { connection: { rpc: { call: spy } }, spy }
}

beforeEach(() => {
  resetCortexMountFailures()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('slot registration', () => {
  it('contributes both cells with the frozen ids and orders', () => {
    const { slots, registered, injected } = fakeSlots()
    apply({ slots, ...fakeConnection().connection })
    expect(injected).toEqual(['settings.section', 'conversation.view'])
    expect(registered.map(item => item.slot)).toEqual(['settings.section', 'conversation.view'])
    const settings = registered[0].options
    expect(settings.id).toBe(SETTINGS_CARD_ID)
    expect(settings.order).toBe(SETTINGS_CARD_ORDER)
    expect(settings.name).toBe('settings.section')
    const panel = registered[1].options
    expect(panel.id).toBe(PANEL_ID)
    expect(panel.order).toBe(PANEL_ORDER)
    expect(typeof settings.label).toBe('function')
    expect((settings.label as () => unknown)()).toBe('Cortex')
  })

  it('registers the real components, not a placeholder', () => {
    const { slots, registered } = fakeSlots()
    apply({ slots, ...fakeConnection().connection })
    for (const entry of registered) {
      expect(typeof entry.component).toBe('function')
      expect((entry.component as { name?: string }).name).toMatch(/Cortex/)
    }
  })

  it('a register() throw is recorded and never propagates (P4)', () => {
    const { slots, registered } = fakeSlots({ throwOn: 'conversation.view' })
    expect(() => apply({ slots, ...fakeConnection().connection })).not.toThrow()
    // The settings card still mounted: one failure cannot take both cells down.
    expect(registered.map(item => item.slot)).toEqual(['settings.section'])
    expect(cortexMountFailures()).toHaveLength(1)
    expect(cortexMountFailures()[0]).toContain('is not declared')
    expect(cortexMountFailures()[0]).toContain('conversation.view')
  })

  it('a missing or partial slots service is a no-op, not a crash', () => {
    expect(() => apply({})).not.toThrow()
    expect(cortexMountFailures().join(' ')).toContain('settings.section: the slots service exposes no inject()')
    resetCortexMountFailures()
    expect(() => apply({ slots: {} })).not.toThrow()
    expect(cortexMountFailures().join(' ')).toContain('no inject()')
    resetCortexMountFailures()
    // An inject() that runs the factory against a slots face with no register()
    // must report the second failure mode too, and still not throw.
    const injectOnly = { inject: (_name: string, build: () => unknown): unknown => build() }
    expect(() => apply({ slots: injectOnly })).not.toThrow()
    expect(cortexMountFailures().join(' ')).toContain('no register()')
    expect(() => apply(null)).not.toThrow()
    expect(() => apply('nonsense')).not.toThrow()
    expect(() => apply(undefined)).not.toThrow()
  })

  it('a slots.inject that itself throws is contained', () => {
    const slots = {
      inject(): unknown {
        throw new Error('slot table is frozen')
      },
      register: () => () => {},
    }
    expect(() => apply({ slots })).not.toThrow()
    expect(cortexMountFailures().join(' ')).toContain('slot table is frozen')
  })

  it('both cells stay in the ledger after apply() and leave it only on fiber unload', () => {
    // Regression: `ctx.effect(disposer, label)` used to be passed the disposer
    // itself. cordis calls the effect body immediately and keeps what it
    // RETURNS, so the disposal ran inside apply(): every cell registered and
    // was torn straight back out, and the panel never appeared — with no throw,
    // no console.warn, and an empty mountFailures. Only a host seam that
    // actually invokes the body can see that.
    const host = cordisHarness()
    apply(host.ctx)
    expect(host.ledger.map(item => item.slot)).toEqual(['settings.section', 'conversation.view'])
    host.unload()
    expect(host.ledger).toEqual([])
  })

  it('every contribution is torn down by the fiber, and only by the fiber', () => {
    const host = cordisHarness()
    apply(host.ctx)
    // Two of the three effects produce a disposer; the panel-models one is a
    // cleanup body that runs on unload and returns nothing to collect.
    expect(host.labels()).toEqual(['dsh-cortex:settings.section', 'dsh-cortex:conversation.view'])
    host.unload()
  })

  it('an undeclared slot yields no disposer, and the other cell still mounts', () => {
    // The host never fires the build callback for an undeclared slot and hands
    // back undefined; the entry must not fabricate a teardown for it.
    const host = cordisHarness()
    const slots = {
      inject: (name: string, build: () => unknown): unknown =>
        name === 'settings.section' ? undefined : host.ctx.slots.inject(name, build),
      register: host.ctx.slots.register,
    }
    apply({ ...host.ctx, slots })
    expect(host.ledger.map(item => item.slot)).toEqual(['conversation.view'])
    expect(host.labels()).toEqual(['dsh-cortex:conversation.view'])
  })
})

describe('the api handed to the cells', () => {
  it('settings inject() gives the card an api that calls the connection', async () => {
    const { slots, registered } = fakeSlots()
    const { connection, spy } = fakeConnection()
    apply({ slots, connection })
    const props = (registered[0].options.inject as () => { api: ReturnType<typeof createCortexApi> })()
    await props.api.ping()
    expect(spy).toHaveBeenCalledWith('/dsh-cortex-read', 'ping', {}, expect.any(AbortSignal))
  })

  it('an RPC reply is unwrapped into the discriminated result', async () => {
    const { slots, registered } = fakeSlots()
    const { connection } = fakeConnection(async () => ({ ok: true, value: { version: '9.9.9' } }) as unknown as Promise<unknown>)
    apply({ slots, connection })
    const props = (registered[0].options.inject as () => { api: ReturnType<typeof createCortexApi> })()
    await expect(props.api.ping()).resolves.toEqual({ ok: true, value: { version: '9.9.9' } })
  })

  it('a connection with no rpc makes every call a typed failure', async () => {
    const { slots, registered } = fakeSlots()
    apply({ slots, connection: {} })
    const props = (registered[0].options.inject as () => { api: ReturnType<typeof createCortexApi> })()
    const result = await props.api.memoryList()
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.error.code).toBe('no-connection')
  })

  it('senderFrom survives a disappeared service between build and call', async () => {
    const call = senderFrom({ rpc: { call: undefined as unknown as (channel: string, endpoint: string) => Promise<unknown> } })
    const result = await call('/dsh-cortex-read', 'ping', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'no-connection' } })
  })
})

describe('conversation.view scope', () => {
  it('one model per session, reused across re-injects', async () => {
    const { slots, registered } = fakeSlots()
    const transport = createMockTransport()
    apply({ slots, connection: { rpc: { call: transport.call } } })
    const inject = registered[1].options.inject as (sessionId?: string) => { model: { state(): unknown } }
    const first = inject('sess-A')
    const again = inject('sess-A')
    // Props objects are rebuilt per call (the host re-injects per render), but
    // the MODEL — the thing holding loaded lists and in-flight writes — is shared.
    expect(again.model).toBe(first.model)
    const second = inject('sess-B')
    expect(second.model).not.toBe(first.model)
    expect(first.model.state()).not.toBe(second.model.state())
  })

  it('the session it was given is sent as the read scope', async () => {
    const { slots, registered } = fakeSlots()
    const transport = createMockTransport()
    apply({
      slots,
      connection: { rpc: { call: transport.call } },
      sessions: {
        binding: (id: string) => ({ session: { header: { cwd: `/repo/${id}` } } }),
        getSnapshot: () => ({ current: 'sess-A', byId: {} }),
      },
    })
    const { model } = injectPanel(registered)
    await model.loadTab('memory')
    expect(transport.last('memory.list')?.payload).toEqual({ cwd: '/repo/sess-A', sessionId: 'sess-A' })
  })

  it('no session context means an unscoped read, which the host answers global-only', async () => {
    const { slots, registered } = fakeSlots()
    const transport = createMockTransport()
    apply({ slots, connection: { rpc: { call: transport.call } } })
    const { model } = injectPanel(registered)
    await model.loadTab('memory')
    expect(transport.last('memory.list')?.payload).toEqual({})
  })

  it('scopeSource falls back to the host snapshot and tolerates no services', () => {
    const ctx = { sessions: { getSnapshot: () => ({ current: 's-1', byId: { 's-1': { cwd: '/x' } } }) } }
    expect(scopeSource(ctx).current()).toEqual({ sessionId: 's-1', cwd: '/x' })
    expect(scopeSource({}).current()).toEqual({})
    expect(scopeSource({}, 'explicit').current()).toEqual({ sessionId: 'explicit' })
  })

  it('scopeSource reads the host through the real cordis context proxy', () => {
    // A plain `{}` answers `ctx.sessions` with undefined, so `?.` absorbs it.
    // cordis answers with a THROW for a service the module did not declare in
    // `inject` (vendor/cordis/src/reflect.ts), and `?.` cannot catch that — the
    // read reached the panel as "failed to render: cannot get property
    // sessions without inject" instead. Model the throw, not the undefined.
    const cordisCtx = (services: Record<string, unknown>): object =>
      new Proxy(services, {
        get(target, prop) {
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop]
          if (typeof prop !== 'string') return undefined
          throw new Error(`cannot get property "${prop}" without inject`)
        },
      })
    const snapshot = { current: 's-1', byId: { 's-1': { cwd: '/x' } } }
    const declared = cordisCtx({ sessions: { getSnapshot: () => snapshot } })
    expect(scopeSource(declared as never).current()).toEqual({ sessionId: 's-1', cwd: '/x' })
    expect(() => (cordisCtx({}) as Record<string, unknown>).sessions).toThrow('without inject')
  })

  it('declares every service the entry reads off the host context', () => {
    // A silent list is how `sessions` went missing once: nothing failed to
    // compile, every unit test passed, and the panel simply never appeared.
    // Keep the read set and the declaration in one place so they cannot drift.
    expect([...inject].sort()).toEqual(['connection', 'sessions', 'slots'])
  })
})

/** Pull the panel props out of the recorded registration. */
function injectPanel(registered: Registered[]): { model: { loadTab(tab: string): Promise<void>; state(): unknown } } {
  const inject = registered[1].options.inject as (sessionId?: string) => { model: { loadTab(tab: string): Promise<void>; state(): unknown } }
  // No session at all: a headless or session-less host must still get a panel.
  return inject(undefined)
}
