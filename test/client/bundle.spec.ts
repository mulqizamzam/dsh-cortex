// @vitest-environment node
/**
 * Artifact proof: the BUILT `lib/client.js`, not the source, registers both slot
 * cells.
 *
 * This is the check that matters for a client plugin — the M0 placeholder was
 * plain ESM, which the host's client-module system loads without registering, so
 * the panel silently never appeared. The bundle must therefore be a
 * `window.__ModuleLoader__.load({ id, factory })` call whose factory returns
 * `{ inject, apply }`, and it must take `react` from the host's shared runtime
 * rather than bundling its own copy.
 *
 * `apply()` is then exercised against a fake slots service — no DOM, because
 * registering a cell touches none. Rendering the components from the bundle
 * would need `react-dom`, which this package does not depend on (see
 * `harness.ts`); the rendered-output proofs live in `render.spec.ts`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const BUNDLE = fileURLToPath(new URL('../../lib/client.js', import.meta.url))
const built = existsSync(BUNDLE)

interface LoaderEntry {
  id: string
  factory: (request: (id: string) => unknown) => Record<string, unknown>
}

/** Evaluate the built file against a stub `window`, exactly as the page does. */
function loadBundle(): { entry: LoaderEntry; exports: Record<string, unknown> } {
  // A mutable holder, not a bare `let`: the only assignment happens inside the
  // `load` callback, which control-flow analysis cannot see, so TS narrows the
  // variable to `never` after the null guard and `captured.factory` stops
  // typechecking. Properties of a mutable object are not narrowed that way.
  const captured: { entry: LoaderEntry | null } = { entry: null }
  const scope = new Function(
    'window',
    readFileSync(BUNDLE, 'utf8'),
  ) as (window: unknown) => void
  scope({
    __ModuleLoader__: {
      load: (entry: LoaderEntry) => {
        captured.entry = entry
      },
    },
  })
  const { entry } = captured
  if (entry === null) throw new Error('the built client.js never called window.__ModuleLoader__.load')
  const require = createRequire(BUNDLE)
  // The host provides these; a plugin that bundled its own React would fail here.
  const shared = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
  const exports = entry.factory((id: string) => {
    if (!shared.has(id)) throw new Error(`client bundle required a non-shared module: ${id}`)
    return require(id)
  })
  return { entry, exports }
}

describe.skipIf(!built)('built client bundle', () => {
  it('registers under the loader id the banner uses', () => {
    const { entry } = loadBundle()
    expect(entry.id).toBe('dsh-cortex')
    expect(typeof entry.factory).toBe('function')
  })

  it('exports the client-plugin face: inject list and apply', () => {
    const { exports } = loadBundle()
    // Asserted on the ARTIFACT, not the source: the host loads this file, and a
    // service missing from `inject` is a render-time throw, never a build error.
    // `sessions` is here because scopeSource reads it; dropping it blanks the panel.
    expect(exports.inject).toEqual(['slots', 'connection', 'sessions'])
    expect(typeof exports.apply).toBe('function')
  })

  it('contributes settings.section and conversation.view from the artifact', () => {
    const { exports } = loadBundle()
    const registered: Array<Record<string, unknown>> = []
    const slots = {
      inject: (_name: string, build: () => unknown): unknown => build(),
      register: (options: Record<string, unknown>, component: unknown): (() => void) => {
        registered.push({ ...options, component })
        return () => {}
      },
    }
    ;(exports.apply as (ctx: unknown) => void)({ slots, connection: {} })
    expect(registered.map(row => [row.name, row.id, row.order])).toEqual([
      ['settings.section', 'cortex', 30],
      ['conversation.view', 'cortex', 12],
    ])
    for (const row of registered) expect(typeof row.component).toBe('function')
  })

  it('a call through the bundled api reaches the connection with the right channel', async () => {
    const { exports } = loadBundle()
    const seen: Array<[string, string, unknown]> = []
    const slots = {
      inject: (_name: string, build: () => unknown): unknown => build(),
      register: (options: Record<string, unknown>, component: unknown): (() => void) => {
        registeredComponents.push(component)
        registrations.push(options)
        return () => {}
      },
    }
    const registeredComponents: unknown[] = []
    const registrations: Array<Record<string, unknown>> = []
    const connection = {
      rpc: {
        call: async (channel: string, endpoint: string, payload?: unknown) => {
          seen.push([channel, endpoint, payload])
          return { ok: true, value: { version: 'bundled' } }
        },
      },
    }
    ;(exports.apply as (ctx: unknown) => void)({ slots, connection })
    const inject = registrations[0].inject as () => { api: { ping(): Promise<unknown> } }
    const props = inject()
    await expect(props.api.ping()).resolves.toEqual({ ok: true, value: { version: 'bundled' } })
    expect(seen[0][0]).toBe('/dsh-cortex-read')
    expect(seen[0][1]).toBe('ping')
  })
})

describe.skipIf(built)('built client bundle (not built)', () => {
  it('is skipped with a reason, not silently', () => {
    expect(built).toBe(false)
  })
})
