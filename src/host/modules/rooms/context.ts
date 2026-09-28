/**
 * The `cortex:rooms` per-turn injection seam (docs/HOST-API.md §3.1,
 * `.dev/BRIEFS.md` §M2/M5 seam rules).
 *
 * Facts this rests on, read from host source rather than assumed:
 * - `SystemPrompt.context(entry)` takes ONE object
 *   (`packages/core/system-prompt/src/index.ts:398`); a duplicate `name` throws,
 *   so `registerRoomContext` runs once per state root.
 * - `entry.text` is evaluated SYNCHRONOUSLY for every assembly
 *   (`index.ts:527`), so the callback may not await anything. That is why the
 *   unread queue lives in memory (loaded by `prime()` at mount, refilled by
 *   every local post) and the disk ledger is written behind it.
 * - The running agent IS in the assembly context:
 *   `assembleContextFor(agent, signal) => ({ agent, scope: agent })`
 *   (`packages/core/agent/src/dispatch.ts:174`, called from
 *   `packages/core/agent-loop/src/agent.ts:230`) even though the base
 *   `AssembleContext` type only declares `{scope?, signal?}`. No agent (a
 *   diagnostic assembly) contributes nothing.
 * - Assembly happens BEFORE `agent/pre-step` in the loop
 *   (`agent.ts:preStep()` assembles, then runs the waterfall), so the watermark
 *   this seam consumes cannot race a second delivery path.
 *
 * Honesty (P1 / G-02): the block starts with the config label
 * (`cfg().injectLabel`, the same header the memory/todo blocks use), and every
 * message inside it carries its own plugin banner. Nothing here is presented as
 * a user message.
 */
import type { HostAgent } from '../../dsh.ts'
import type { RoomService } from './service.ts'

/** Registration name — one per process (duplicate = host throws). */
export const ROOMS_CONTEXT_NAME = 'cortex:rooms'

/** Ordering slot: after memory (40) and todo (41), before prompts (43). */
export const ROOMS_CONTEXT_ORDER = 42

/** The minimal shape of `ctx.get('systemPrompt')` this seam needs. */
export interface SystemPromptLike {
  context?(entry: { name: string, order: number, text: (context: unknown) => string }): unknown
}

/** The host assembly context, narrowed to what is actually present (see header). */
export interface AssemblyContext {
  agent?: HostAgent
  scope?: unknown
  signal?: AbortSignal
}

/**
 * The sync text provider. Empty string means "contribute nothing": a diagnostic
 * assembly (no agent), a disabled module, or a session with no unread mail.
 */
export function roomsContextText(svc: RoomService): (context: unknown) => string {
  return (context: unknown): string => {
    try {
      const agent = (context as AssemblyContext | undefined)?.agent
      const sessionId = typeof agent?.id === 'string' ? agent.id : ''
      if (sessionId === '') return ''
      if (!svc.enabled) return ''
      // A session that started elsewhere (or after this process booted) has no
      // in-memory view of the ledger. Load it in the background; its next
      // assembly renders the mail. Never await inside a prompt callback.
      if (svc.needsPrime(sessionId)) void svc.prime(sessionId).catch(() => {})
      const block = svc.renderFor(sessionId)
      return block
    } catch {
      // A prompt seam must never break a turn (P4); the mail stays on disk.
      return ''
    }
  }
}

export interface ContextRegistration {
  ok: boolean
  message: string
  dispose?: () => void
}

/**
 * Register the seam once. `get('systemPrompt')` may be absent on a reduced
 * profile, and a duplicate name throws, so both are handled and REPORTED
 * (P4: never silent, never fatal).
 */
export function registerRoomContext(
  svc: RoomService,
  options: {
    get?: (name: string) => unknown
    /** Cordis effect scope; the disposer it returns unwinds with the plugin. */
    effect?: (run: () => (() => void) | void, label?: string) => unknown
    name?: string
  },
): ContextRegistration {
  const entryName = options.name ?? ROOMS_CONTEXT_NAME
  try {
    const service = typeof options.get === 'function' ? options.get('systemPrompt') : undefined
    if (service === undefined || service === null) {
      return { ok: false, message: `no systemPrompt service: room mail will not be injected (use cortex_room_read)` }
    }
    const systemPrompt = service as SystemPromptLike
    if (typeof systemPrompt.context !== 'function') {
      return { ok: false, message: 'systemPrompt.context() is unavailable on this host: room mail will not be injected' }
    }
    const text = roomsContextText(svc)
    const apply = (): (() => void) | void => {
      const disposer = systemPrompt.context?.({ name: entryName, order: ROOMS_CONTEXT_ORDER, text })
      return typeof disposer === 'function' ? (): void => { disposer() } : undefined
    }
    let dispose: (() => void) | undefined
    if (typeof options.effect === 'function') {
      options.effect(() => {
        dispose = apply() ?? undefined
        return dispose
      }, `${entryName} context`)
    } else {
      dispose = apply() ?? undefined
    }
    return { ok: true, message: `${entryName} registered at order ${String(ROOMS_CONTEXT_ORDER)}`, ...(dispose === undefined ? {} : { dispose }) }
  } catch (error) {
    return { ok: false, message: `context registration failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
