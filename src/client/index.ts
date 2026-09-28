/**
 * Browser half of dsh-cortex — the client entry (DSH 0.1.1-rc.2 client plugin).
 *
 * `apply(rawContext)` runs inside the host's client-module loader (`lib/client.js`
 * is a `window.__ModuleLoader__.load({id, factory})` bundle). It contributes two
 * slot cells and nothing else:
 *
 *   settings.section   id 'cortex'  order 30  → the health / self-test card
 *   conversation.view  id 'cortex'  order 12  → the Memory | Todo | Rooms |
 *                                                Prompts | Jobs panel
 *
 * Hard rules this file exists to honour:
 *
 *   - P4: `apply` never throws. `register()` THROWS on an undeclared slot and on
 *     an equal-priority collision in an occupied cell (HOST-API §9.5), so every
 *     call is guarded and a refusal is recorded instead of reaching the page. A
 *     dead panel must not cost the user their conversation.
 *   - Purity: no runtime import of any host package. `react` is the only runtime
 *     import (a declared shared external); everything else is `import type`,
 *     including the track unions taken from `src/host/types.ts`.
 *   - A client plugin cannot create sessions — spawning goes through `rooms.spawn`
 *     (host-side `agents.create`), and the button stays disabled until
 *     `sessions.status` answers `canSpawn === true`.
 *   - All traffic is `/dsh-cortex-read` + `/dsh-cortex-write` through
 *     `connection.rpc.call` (loopback-fenced on the host side). No HTTP route, no
 *     token, and no browser-side read of the state directory.
 *
 * `inject` lists the CORDIS SERVICES this entry reads. It is a different layer
 * from `package.json` → `dsh.client.inject`, which orders this bundle's APPLY
 * after other plugin bundles; see the `inject` declaration below.
 */
import type { CortexApi, CortexScope, RpcCall } from './api.ts'
import { createCortexApi } from './api.ts'
import type { PanelModel, PanelScopeSource } from './panel-model.ts'
import { createPanelModel } from './panel-model.ts'
import { CortexPanel } from './panel.ts'
import { CortexSettingsCard, SETTINGS_CARD_ID, SETTINGS_CARD_ORDER } from './settings.ts'

/**
 * Cordis services this entry reads off the host context: `slots` to
 * contribute the two cells, `connection` for every RPC, `sessions` to scope a
 * read to the session being viewed.
 *
 * The list is load-bearing, not documentation. cordis hands `apply` a Proxy
 * that THROWS on any service the fiber did not declare here
 * (`vendor/cordis/src/reflect.ts`), so an undeclared read is not an
 * `undefined` that optional chaining absorbs — it reaches the panel as
 * "cortex panel failed to render: cannot get property X without inject".
 */
export const inject = ['slots', 'connection', 'sessions']

/** Slot cell identity for the conversation panel. */
export const PANEL_ID = 'cortex'
export const PANEL_ORDER = 12

// -------------------------------------------------------- host shape (local) --

/** The `connection.rpc` face this entry consumes. */
interface RpcFace {
  call(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<unknown>
}

interface ConnectionLike {
  rpc?: RpcFace
}

/**
 * Local mirror of the pieces of the host's client context this entry touches.
 * Structural and all-optional: a headless or half-loaded context must degrade to
 * "this card did not mount, and here is why", never to a crash.
 */
interface SlotsFace {
  inject(name: string, build: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface StoreSnapshot<T> {
  getSnapshot?(): T
}

interface SessionRowLike {
  id?: string
  cwd?: string
}

interface SessionsFace extends StoreSnapshot<{ current?: string | null; byId?: Record<string, SessionRowLike> }> {
  binding?(sessionId: string): { session?: { header?: { cwd?: string } } } | undefined
}

interface WorkspacesFace extends StoreSnapshot<{ items?: Array<{ workspaceId?: string; path?: string; title?: string }> }> {}

export interface ClientContext {
  slots?: SlotsFace
  connection?: ConnectionLike
  sessions?: SessionsFace
  workspaces?: WorkspacesFace
  /** Host effect registry: `effect(body, name)` runs `body` now and tears down
   *  with whatever `body` returns, so a body must RETURN its disposer. */
  effect?(body: () => (() => void) | void, name?: string): unknown
}

/** Props the settings card receives from the cell's `inject`. */
export interface SettingsCardProps {
  api: CortexApi
}

/** Props the conversation panel receives; `sessionId` is the host's active row. */
export interface PanelProps {
  model: PanelModel
  sessionId?: string
}

// ----------------------------------------------------------------- transport --

/**
 * The RPC sender this UI talks through. A missing service becomes a typed
 * `{ok:false}` answer, so the adapter reports it as a rendered state instead of
 * throwing inside a click handler.
 */
export function senderFrom(connection: ConnectionLike | undefined): RpcCall {
  const rpc = connection?.rpc
  if (rpc === undefined || typeof rpc.call !== 'function') {
    return async () => ({
      ok: false,
      error: { code: 'no-connection', message: 'connection.rpc.call is unavailable on this client context' },
    })
  }
  return (channel, endpoint, payload, signal) => rpc.call(channel, endpoint, payload, signal)
}

/**
 * Best-effort scope: which session the user is looking at, and its cwd. The HOST
 * owns every git probe (`modules/memory/scope.ts`); this only stops a read from
 * answering global-only when a session context does exist.
 */
export function scopeSource(ctx: ClientContext, sessionId?: string): PanelScopeSource {
  return {
    current: (): CortexScope => {
      const snapshot = ctx.sessions?.getSnapshot?.()
      const active = sessionId !== undefined && sessionId !== '' ? sessionId : typeof snapshot?.current === 'string' ? snapshot.current : undefined
      if (active === undefined) return {}
      const cwd = ctx.sessions?.binding?.(active)?.session?.header?.cwd ?? snapshot?.byId?.[active]?.cwd
      return { sessionId: active, ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}) }
    },
  }
}

// -------------------------------------------------------------------- mount --

/** Registrations that failed, kept so the entry can still say something true. */
const mountFailures: string[] = []
let reported = 0

export function cortexMountFailures(): readonly string[] {
  return mountFailures
}

/** For tests only: forget recorded mount failures. */
export function resetCortexMountFailures(): void {
  mountFailures.length = 0
  reported = 0
}

/** `slots.register` returns a disposer; a throw is recorded, never re-raised. */
function register(ctx: ClientContext, slot: string, options: Record<string, unknown>, component: unknown): (() => void) | null {
  const slots = ctx.slots
  if (slots === undefined || typeof slots.register !== 'function') {
    mountFailures.push(`${slot}: the slots service exposes no register()`)
    return null
  }
  try {
    const disposer = slots.register({ name: slot, ...options }, component)
    return typeof disposer === 'function' ? () => void (disposer as () => unknown)() : null
  } catch (error) {
    // §9.5: undeclared slot, or an occupied cell at the same priority. Either
    // way, this is someone else's page to keep rendering.
    mountFailures.push(`${slot}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Contribute to a slot when it exists; a missing declaration stays a no-op. */
function contribute(ctx: ClientContext, slot: string, build: () => (() => void) | null): void {
  const slots = ctx.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    mountFailures.push(`${slot}: the slots service exposes no inject()`)
    return
  }
  try {
    const disposer = slots.inject(slot, build)
    if (typeof ctx.effect === 'function' && typeof disposer === 'function') {
      // ctx.effect(execute) INVOKES execute now and registers what it RETURNS
      // as the teardown (cordis fiber.ts `effect()`). Handing over the disposer
      // itself therefore disposes the contribution on the spot: both cells land
      // in the ledger and are pulled out of it again inside this same apply(),
      // so the panel is invisible with nothing thrown and nothing logged.
      ctx.effect(() => disposer as () => void, `dsh-cortex:${slot}`)
    }
  } catch (error) {
    mountFailures.push(`${slot}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Plugin entry. The exported shape (name/inject/apply) is what the host's
 * client-module loader calls; nothing in here may throw (P4).
 */
export function apply(rawContext: unknown): void {
  try {
    const ctx = (rawContext !== null && typeof rawContext === 'object' ? rawContext : {}) as ClientContext
    const api = createCortexApi(senderFrom(ctx.connection))
    const models = new Map<string, PanelModel>()

    contribute(ctx, 'settings.section', () =>
      register(
        ctx,
        'settings.section',
        {
          id: SETTINGS_CARD_ID,
          order: SETTINGS_CARD_ORDER,
          label: () => 'Cortex',
          inject: (): SettingsCardProps => ({ api }),
        },
        CortexSettingsCard,
      ),
    )

    // One model per session cell: the host keys `conversation.view` by session,
    // so switching sessions must not carry another project's loaded lists around.
    contribute(ctx, 'conversation.view', () =>
      register(
        ctx,
        'conversation.view',
        {
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => 'Cortex',
          inject: (sessionId?: unknown): PanelProps => {
            const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '__any__'
            let model = models.get(key)
            if (model === undefined) {
              model = createPanelModel(api, scopeSource(ctx, typeof sessionId === 'string' ? sessionId : undefined))
              models.set(key, model)
            }
            return { model, ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}) }
          },
        },
        CortexPanel,
      ),
    )

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        for (const model of models.values()) model.dispose()
        models.clear()
      }, 'dsh-cortex: panel models')
    }

    // Report what THIS apply() could not mount (the array is cumulative for a
    // test or a second context, the log is not).
    for (const failure of mountFailures.slice(reported)) {
      // eslint-disable-next-line no-console -- the console is the only report seam a client plugin owns
      console.warn(`[dsh-cortex] ${failure}`)
    }
    reported = mountFailures.length
  } catch (error) {
    // eslint-disable-next-line no-console -- apply() must never reach the page
    console.warn('[dsh-cortex] client apply failed:', error instanceof Error ? error.message : String(error))
  }
}
