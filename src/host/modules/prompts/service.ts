/**
 * M4 · the prompts service: the library, the pending gate, and the SYNC render
 * side of the inject queue.
 *
 * Why the queue is in memory and the disk is behind it (host fact, not taste):
 * `systemPrompt.context` evaluates `text` SYNCHRONOUSLY at every assembly
 * (`packages/core/system-prompt/src/index.ts:527`, and `docs/HOST-API.md` §3),
 * while every state read here is async. So, exactly like the rooms module's mail
 * queue: `prime(sessionId)` loads, `renderFor(sessionId)` consumes in memory and
 * is the ONLY place a round is ever spent, and the file lands behind it
 * (fire-and-forget, awaited by {@link flushQueueWrites} in tests). A write that
 * fails leaves the in-memory truth correct for this process and says so — the
 * worst case after a restart is one injection rendered twice, never a silent
 * lie (P4).
 *
 * Scoping rule (v1, deliberate): an injection targets the CALLING session's
 * queue only. `injectPush`/`injectConsume` key the file by session id
 * (`store.paths.inject`), so a foreign `targetSessionId` cannot be honoured and
 * is refused with that sentence. The UI panel is the human path and may name a
 * session (it is that user's own session); the agent tool may not.
 */
import { errorMessage } from '../../../lib/errors.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { neutralize } from '../../../lib/sanitize.ts'
import type { ModuleDeps, PromptDoc } from '../../types.ts'
import { renderPromptBlock } from './render.ts'
import {
  MANUAL_TEXT_CHARS, MANUAL_TITLE, ONCE_TURNS, PROMPTS_BLOCK_CHARS, PROMPT_BODY_CHARS,
  QUEUE_MAX_ROWS, STICKY_MAX_TURNS, advanceRows, clampBody, makeRow, normalizeRows,
  queueFile, safeSessionKey,
} from './queue.ts'
import type { PromptRow } from './queue.ts'

/** Live-agents rows we remember queues for; the map must not grow without a ceiling. */
const SESSION_MAX = 32

/** A tool/UI answer: a sentence plus the structured part the caller needs. */
export interface PromptOutcome {
  ok: boolean
  message: string
  code?: string
  doc?: PromptDoc | null
  rows?: PromptRow[]
  pendingId?: string
}

export interface InjectRequest {
  /** Session whose queue receives the row (the caller's own session, v1). */
  sessionId: string
  mode: 'once' | 'sticky' | 'clear'
  /** A saved prompt to inject. Mutually exclusive with `text`. */
  promptId?: string
  /** Typed text (UI path): never written to the library. */
  text?: string
}

export class PromptsService {
  readonly deps: ModuleDeps
  /** sessionId(sanitized) -> live queue rows, in request order. */
  private readonly queues = new Map<string, PromptRow[]>()
  /** Sessions whose queue file has been read in this process. */
  private readonly primed = new Set<string>()
  /** In-flight queue writes, so a test (or shutdown) can await them. */
  private readonly writes = new Set<Promise<void>>()
  /**
   * The write chain. Two renders in a row produce two snapshots of the same
   * file; if they were allowed to race, the OLDER one could land last and a
   * restart would resurrect a round that was already spent. Every queue write
   * therefore waits for the previous one, and the payload is captured at call
   * time, not at write time.
   */
  private chain: Promise<void> = Promise.resolve()
  private readonly disposers: Array<() => void> = []
  private seamInstalled = false

  constructor(deps: ModuleDeps) {
    this.deps = deps
  }

  get store() {
    return this.deps.store
  }

  /** False when `prompts.enabled` is off (P3 kill-switch). */
  get enabled(): boolean {
    return this.deps.cfg().prompts.enabled === true
  }

  /** The refusal sentence, with the config key that would change it. */
  get disabledMessage(): string {
    return 'prompts are disabled by config (prompts.enabled = false); nothing was changed.'
  }

  private warn(message: string): void {
    this.deps.warn(`prompts: ${neutralize(message)}`)
  }

  // ------------------------------------------------------------- library ----
  /** All docs, newest first, with the disabled gate and a hard row ceiling. */
  async list(options: { category?: string; enabled?: boolean } = {}): Promise<PromptDoc[]> {
    const result = await this.store.listPrompts(options)
    if (!result.ok) {
      this.warn(`listPrompts failed: ${result.error}`)
      return []
    }
    return result.data
  }

  async get(id: string): Promise<PromptDoc | null> {
    if (!isSafeKey(id)) return null
    const result = await this.store.getPrompt(id)
    if (!result.ok) {
      this.warn(`getPrompt(${id}) failed: ${result.error}`)
      return null
    }
    return result.data ?? null
  }

  /**
   * The AI path: a proposal, never a write. The pending queue is the single
   * gate that keeps a model from filling the library that injects its own next
   * turns (DESIGN §4, P3).
   */
  async proposeSave(input: { title: string; body: string; category?: string; sessionId?: string; reason?: string }): Promise<PromptOutcome> {
    const title = input.title.trim()
    const body = input.body.trim()
    if (title === '') return nope('title is required: name the workflow you want back next session')
    if (body === '') return nope('body is required: the text to inject')
    const result = await this.store.addPending({
      kind: 'prompt',
      proposal: {
        title: clampBody(neutralize(title), 120),
        body: clampBody(neutralize(body), 20000),
        ...(input.category === undefined || input.category.trim() === '' ? {} : { category: clampBody(neutralize(input.category), 40) }),
      },
      ...(input.reason === undefined || input.reason.trim() === '' ? {} : { reason: input.reason }),
      ...(input.sessionId === undefined ? {} : { fromSessionId: input.sessionId }),
    })
    if (!result.ok) return nope(`could not queue the proposal: ${result.error}`, 'write-failed')
    return {
      ok: true,
      pendingId: result.data.id,
      message: `queued as a proposal (pending/${result.data.id}); it is NOT in the prompt library yet. The user approves or rejects it in the Cortex panel.`,
    }
  }

  /** The human/UI path: write straight to the library (no pending gate, §M4). */
  async saveDoc(input: { id?: string; title: string; body: string; category?: string }): Promise<PromptOutcome> {
    const title = input.title.trim()
    const body = input.body
    if (title === '') return nope('title is required')
    if (body.trim() === '') return nope('body is required')
    if (input.id !== undefined) {
      if (!isSafeKey(input.id)) return nope('id is not a prompt id')
      const current = await this.get(input.id)
      if (current === null) return nope(`no saved prompt ${input.id}`, 'not-found')
      const updated = await this.store.updatePrompt(input.id, {
        title: clampBody(neutralize(title), 120),
        body: clampBody(neutralize(body), 20000),
        ...(input.category === undefined ? {} : { category: clampBody(neutralize(input.category), 40) }),
      })
      if (!updated.ok) return nope(`could not update the prompt: ${updated.error}`, 'write-failed')
      if (updated.data === null) return nope(`prompt ${input.id} disappeared before the update landed`, 'not-found')
      await this.syncRows(updated.data)
      return { ok: true, doc: updated.data, message: `updated prompt ${updated.data.id}` }
    }
    const added = await this.store.addPrompt({
      title: clampBody(neutralize(title), 120),
      body: clampBody(neutralize(body), 20000),
      ...(input.category === undefined || input.category.trim() === '' ? {} : { category: input.category.trim() }),
    })
    if (!added.ok) return nope(`could not save the prompt: ${added.error}`, 'write-failed')
    return { ok: true, doc: added.data, message: `saved prompt ${added.data.id}` }
  }

  async toggle(id: unknown, enabled: unknown): Promise<PromptOutcome> {
    if (typeof id !== 'string' || !isSafeKey(id)) return nope('id must be a prompt id from cortex_prompt_list')
    if (typeof enabled !== 'boolean') return nope('enabled must be true or false')
    const current = await this.get(id)
    if (current === null) return nope(`no saved prompt ${id}`, 'not-found')
    const result = await this.store.updatePrompt(id, { enabled })
    if (!result.ok) return nope(`could not toggle ${id}: ${result.error}`, 'write-failed')
    if (result.data === null) return nope(`prompt ${id} disappeared before the update landed`, 'not-found')
    // Turning a prompt off must also stop it from being injected any further.
    await this.syncRows(result.data)
    return { ok: true, doc: result.data, message: `${enabled ? 'enabled' : 'disabled'} prompt ${id}` }
  }

  /** Destructive, so the confirm string is exact (contract: `confirm: "DELETE"`). */
  async remove(id: unknown, confirm: unknown): Promise<PromptOutcome> {
    if (typeof id !== 'string' || !isSafeKey(id)) return nope('id must be a prompt id')
    if (confirm !== 'DELETE') return nope('delete needs confirm: "DELETE" exactly; nothing was deleted')
    const current = await this.get(id)
    if (current === null) return nope(`no saved prompt ${id}`, 'not-found')
    const result = await this.store.deletePrompt(id)
    if (!result.ok) return nope(`could not delete ${id}: ${result.error}`, 'write-failed')
    if (result.data !== true) return nope(`prompt ${id} was already gone`, 'not-found')
    await this.dropRows(id)
    return { ok: true, message: `deleted prompt ${id} (${current.title}); queued injections of it were dropped too` }
  }

  /**
   * A prompt was edited or switched off through this module: the queued rows
   * that cite it must follow, in every session that holds one. A row whose body
   * went empty is dropped rather than left to render a header over nothing.
   */
  private async syncRows(doc: PromptDoc): Promise<void> {
    const body = clampBody(neutralize(doc.body), PROMPT_BODY_CHARS)
    for (const [key, rows] of [...this.queues.entries()]) {
      const next = rows
        .filter(row => !(row.promptId === doc.id && (doc.enabled !== true || body.trim() === '')))
        .map(row => (row.promptId === doc.id ? { ...row, title: doc.title, body } : row))
      if (next.length === rows.length && next.every((row, index) => row === rows[index])) continue
      this.queues.set(key, next)
      this.queueWrite(key, next)
    }
  }

  /** Delete: drop every queued row that referenced the prompt, whatever session. */
  private async dropRows(promptId: string): Promise<void> {
    for (const [key, rows] of [...this.queues.entries()]) {
      const next = rows.filter(row => row.promptId !== promptId)
      if (next.length === rows.length) continue
      this.queues.set(key, next)
      this.queueWrite(key, next)
    }
  }

  // --------------------------------------------------------------- queues ---
  /**
   * The rows this process holds for one session, request order first. This is
   * ALSO the read the panel uses (`inject.now` answers from it) and the seam's
   * own view: one accessor, so a diagnostic can never disagree with a render.
   */
  queueFor(sessionId: string | undefined): PromptRow[] {
    if (sessionId === undefined || sessionId === '') return []
    return this.queues.get(safeSessionKey(sessionId)) ?? []
  }

  /** True when the queue file for this session has not been read yet. */
  needsPrime(sessionId: string | undefined): boolean {
    if (sessionId === undefined || sessionId === '') return false
    return !this.primed.has(safeSessionKey(sessionId))
  }

  /**
   * Read one session's queue file. The store's `readInjectQueue` quarantines a
   * corrupt file, so a bad `inject/<id>.json` costs that session its queue and
   * nothing else (P4). Rows pointing at a prompt that is gone or switched off
   * are dropped here, so a deleted workflow cannot resurface in a later turn.
   */
  async prime(sessionId: string): Promise<PromptRow[]> {
    if (sessionId === '') return []
    const key = safeSessionKey(sessionId)
    const stored = normalizeRows((await this.store.readInjectQueue(sessionId)).items)
    const live: PromptRow[] = []
    for (const row of stored) {
      if (row.promptId === '') {
        live.push(row)
        continue
      }
      const doc = await this.get(row.promptId)
      if (doc === null || doc.enabled !== true) {
        this.warn(`dropped queued injection of ${row.promptId} (${doc === null ? 'no such prompt' : 'prompt disabled'})`)
        continue
      }
      const body = clampBody(neutralize(doc.body), PROMPT_BODY_CHARS)
      if (body.trim() === '') {
        this.warn(`dropped queued injection of ${row.promptId} (its body is empty)`)
        continue
      }
      live.push({ ...row, title: doc.title, body })
    }
    const trimmed = live.slice(0, QUEUE_MAX_ROWS)
    this.remember(key, trimmed)
    this.primed.add(key)
    if (trimmed.length !== stored.length) this.queueWrite(key, trimmed)
    return trimmed
  }

  /**
   * Queue an injection. The saved-prompt path reads the library so the row
   * carries the real title/body (a render must never await); the manual-text
   * path stores typed text without writing it to the library.
   */
  async inject(request: InjectRequest): Promise<PromptOutcome> {
    if (!this.enabled) return nope(this.disabledMessage, 'disabled')
    const sessionId = request.sessionId
    if (sessionId === '' || sessionId.length > 200) return nope('no session to inject into', 'no-session')
    if (request.mode === 'clear') return this.clearQueue(sessionId, request.promptId)
    if (request.promptId !== undefined && request.text !== undefined) {
      return nope('pass either promptId or text, not both', 'bad-request')
    }
    await this.ensurePrimed(sessionId)
    const key = safeSessionKey(sessionId)
    const rows = [...(this.queues.get(key) ?? [])]
    const at = new Date().toISOString()
    const mode = request.mode === 'sticky' ? 'sticky' : 'once'

    if (request.promptId !== undefined) {
      const id = request.promptId
      if (!isSafeKey(id)) return nope('promptId is not a prompt id from cortex_prompt_list', 'bad-request')
      const doc = await this.get(id)
      if (doc === null) return nope(`no saved prompt ${id}; save it first (cortex_prompt_save) or pass text instead`, 'not-found')
      if (doc.enabled !== true) return nope(`prompt ${id} is switched off; enable it (cortex_prompt_toggle) before injecting it`, 'disabled-prompt')
      const row = makeRow({ promptId: id, mode, title: doc.title, body: doc.body, at })
      const kept = rows.filter(existing => existing.promptId !== id)
      kept.push(row)
      return this.commitQueue(key, kept, `queued ${mode} injection of "${row.title}" for session ${key} (${String(row.rounds)} round${row.rounds === 1 ? '' : 's'} of text)`)
    }

    const text = String(request.text ?? '').trim()
    if (text === '') return nope('nothing to inject: pass promptId or text', 'bad-request')
    const row = makeRow({
      promptId: '',
      mode,
      title: MANUAL_TITLE,
      body: clampBody(neutralize(text), MANUAL_TEXT_CHARS),
      at,
    })
    const kept = [...rows, row]
    return this.commitQueue(key, kept, `queued ${mode} injection of typed text for session ${key} (${String(row.rounds)} round${row.rounds === 1 ? '' : 's'} of text)`)
  }

  /** Empty (or clear one prompt from) a session's queue. */
  async clearQueue(sessionId: string, promptId?: string): Promise<PromptOutcome> {
    if (sessionId === '') return nope('no session to clear', 'no-session')
    await this.ensurePrimed(sessionId)
    const key = safeSessionKey(sessionId)
    const rows = this.queues.get(key) ?? []
    if (promptId === undefined || promptId === '') {
      if (rows.length === 0) return { ok: true, rows: [], message: `nothing queued for session ${key}` }
      return this.commitQueue(key, [], `cleared ${String(rows.length)} queued injection${rows.length === 1 ? '' : 's'} for session ${key}`)
    }
    const next = rows.filter(row => row.promptId !== promptId)
    if (next.length === rows.length) return { ok: true, rows, message: `nothing was queued for prompt ${promptId} in session ${key}` }
    return this.commitQueue(key, next, `cleared the queued injection of ${promptId} for session ${key}`)
  }

  private async commitQueue(key: string, rows: readonly PromptRow[], message: string): Promise<PromptOutcome> {
    const trimmed = rows.slice(-QUEUE_MAX_ROWS)
    this.remember(key, trimmed)
    this.primed.add(key)
    this.queueWrite(key, trimmed)
    return { ok: true, rows: trimmed, message }
  }

  /**
   * Hold one session's queue, evicting the least recently used session beyond
   * {@link SESSION_MAX}: a long-lived host with many finished sessions must not
   * grow this process without bound (P2). The evicted session's rows stay on
   * disk, so its next assembly re-primes them — nothing is lost, only re-read.
   */
  private remember(key: string, rows: readonly PromptRow[]): void {
    this.queues.delete(key)
    this.queues.set(key, [...rows])
    while (this.queues.size > SESSION_MAX) {
      const oldest = this.queues.keys().next()
      if (oldest.done === true) break
      this.queues.delete(oldest.value)
      this.primed.delete(oldest.value)
    }
  }

  private async ensurePrimed(sessionId: string): Promise<void> {
    if (!this.needsPrime(sessionId)) return
    try {
      await this.prime(sessionId)
    } catch (error) {
      this.warn(`prime(${sessionId}) failed: ${errorMessage(error)}`)
    }
  }

  /**
   * Write the queue file behind the in-memory truth (awaited by `flushQueueWrites`).
   *
   * The store owns the PATH (`paths.inject`, which sanitizes the session id) and
   * the TOLERANT READ (`readInjectQueue`, which quarantines a corrupt file), but
   * `injectPush` can only carry `{promptId, mode}` — no round counter, no typed
   * text — so the queue is written here through the same atomic primitive the
   * store itself uses. The rows stay a superset of the store's shape, so
   * `injectPush`/`injectConsume` called from anywhere else still read and write
   * this file coherently.
   */
  private queueWrite(key: string, rows: readonly PromptRow[]): void {
    const payload = queueFile(key, rows, new Date().toISOString())
    const task = this.chain.then(async () => {
      try {
        const written = await this.store.writeStateJson(this.store.paths.inject(key), payload)
        if (!written.ok) throw new Error(written.error)
      } catch (error) {
        // In-memory stays correct for this process; the loss is only the part
        // that would have survived a restart. Say so, never throw (P4).
        this.warn(`queue write failed for ${key}: ${errorMessage(error)} (this process keeps it in memory)`)
      }
    })
    this.chain = task.then(() => undefined, () => undefined)
    this.writes.add(task)
    void this.chain.finally(() => { this.writes.delete(task) })
  }

  /** Await every queued file write (tests; a shutdown path may too). */
  async flushQueueWrites(): Promise<void> {
    for (let pass = 0; pass < 5; pass += 1) {
      if (this.writes.size === 0) return
      await Promise.allSettled([...this.writes])
    }
  }

  /**
   * The one place a round is spent. Returns the block for this assembly and
   * advances the queue; an entry dropped by the budget is not charged, a `once`
   * row is gone, and a spent `sticky` row survives exactly one more render to
   * say it expired. '' (with no state change) when there is nothing to show.
   */
  renderFor(sessionId: string | undefined): string {
    if (!this.enabled) return ''
    if (sessionId === undefined || sessionId === '') return ''
    const key = safeSessionKey(sessionId)
    const rows = this.queues.get(key) ?? []
    if (rows.length === 0) return ''
    const config = this.deps.cfg()
    const rendered = renderPromptBlock({
      rows,
      label: config.injectLabel,
      bodyChars: PROMPT_BODY_CHARS,
      budget: PROMPTS_BLOCK_CHARS,
    })
    if (rendered.text === '') return ''
    const next = advanceRows(rows, rendered.rendered)
    this.queues.set(key, next)
    this.queueWrite(key, next)
    return rendered.text
  }

  /** The `cortex:prompts` text provider: sync, string, never throws (P4). */
  contextText = (context: unknown): string => {
    try {
      const config = this.deps.cfg()
      if (!this.enabled || config.inject.enabled !== true) return ''
      const agent = (context as { agent?: unknown } | undefined)?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined || sessionId === '') return ''
      // A session that started elsewhere (or after this process booted) has no
      // in-memory queue: load it now, render it on the next assembly.
      if (this.needsPrime(sessionId)) void this.prime(sessionId).catch(() => {})
      return this.renderFor(sessionId)
    } catch (error) {
      this.warn(`context render failed: ${errorMessage(error)}`)
      return ''
    }
  }

  // ---------------------------------------------------------------- wire ---
  /**
   * Session ids live in this process (`ctx.agents.roots()`), [] when the host
   * exposes no agents service or the call fails. Used to warm queues at mount so
   * a queue written before a restart is rendered on the session's FIRST turn
   * instead of its second.
   */
  liveSessions(): string[] {
    const agents = this.deps.ctx.agents
    if (agents === undefined || typeof agents.roots !== 'function') return []
    try {
      return agents.roots().map(agent => sessionIdOf(agent) ?? '').filter(id => id !== '')
    } catch (error) {
      this.warn(`agents.roots() failed: ${errorMessage(error)}`)
      return []
    }
  }

  /**
   * Warm every live session's queue (mount path; failures are reported, P4).
   * Awaitable so a caller (or a test) can prove the first assembly already
   * carries the text; `apply()` fires it without waiting.
   */
  async warmLiveSessions(): Promise<void> {
    await Promise.all(this.liveSessions().map(async sessionId => {
      try {
        await this.prime(sessionId)
      } catch (error) {
        this.warn(`prime(${sessionId}) failed: ${errorMessage(error)}`)
      }
    }))
  }

  /** True once the `cortex:prompts` registration succeeded. */
  get hasContextSeam(): boolean {
    return this.seamInstalled
  }

  /**
   * Register the seam and the priming listener. One registration per host
   * context: a repeat `apply()` (hot reload, a second mount) reuses the queue it
   * already installed instead of paying the host's duplicate-name throw, which
   * is why the guard below reports 'already' rather than a refusal.
   */
  install(): void {
    const ctx = this.deps.ctx
    if (registeredContexts.has(ctx)) {
      this.seamInstalled = true
      return
    }
    try {
      const prompt = ctx.get('systemPrompt') as { context?: (value: { name: string; order: number; text: (context: unknown) => string }) => unknown } | undefined
      if (typeof prompt?.context !== 'function') {
        this.warn('systemPrompt.context unavailable — saved workflows will not be injected this session')
      } else {
        const disposer = prompt.context({ name: PROMPTS_CONTEXT_NAME, order: PROMPTS_CONTEXT_ORDER, text: this.contextText as never })
        this.seamInstalled = true
        registeredContexts.add(ctx)
        if (typeof disposer === 'function') this.disposers.push(disposer as () => void)
      }
    } catch (error) {
      this.warn(`context registration refused: ${errorMessage(error)}`)
    }

    try {
      const stop = ctx.on('agent/created', ((payload: { agent?: unknown }) => {
        const sessionId = sessionIdOf(payload?.agent)
        if (sessionId !== undefined) void this.prime(sessionId).catch(() => {})
      }) as never)
      if (typeof stop === 'function') this.disposers.push(stop as () => void)
    } catch (error) {
      this.warn(`agent/created listener refused: ${errorMessage(error)}`)
    }
  }

  /** Undo registrations/listeners (module teardown; never throws). */
  dispose(): void {
    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch {
        // A host-side disposer failure is not ours to propagate (P4).
      }
    }
    // Forget the context too: our disposers just unregistered its seam, so a
    // later mount on the same context must be able to install one again.
    registeredContexts.delete(this.deps.ctx)
    this.queues.clear()
    this.primed.clear()
  }
}

/** The seam's identity: one registration per process (duplicate name throws). */
export const PROMPTS_CONTEXT_NAME = 'cortex:prompts'
/** Order: memory 40, todo 41, rooms 42, prompts 43, logs nudge 44. */
export const PROMPTS_CONTEXT_ORDER = 43

/** Defensive read of `agent.id` — the queue key, same rule as the logs module. */
export function sessionIdOf(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The v1 scope rule, in the exact sentence a caller is refused with. */
export const INJECT_SCOPE_REFUSAL = 'v1: inject applies to the calling session only'

/**
 * Which queue an AGENT request may write.
 *
 * The inject queue is keyed by the session that will RENDER it, and v1 has no
 * cross-session grant: no room membership check, no "inject into that other
 * session". A caller that names its own session is fine; one that names another
 * is refused with {@link INJECT_SCOPE_REFUSAL} and changes nothing. (The UI
 * endpoint is a different path — see `rpc.ts`: a human clicking a session's own
 * panel is the caller, and the frozen contract asks for `targetSessionId`.)
 */
export function resolveAgentInjectTarget(caller: string | undefined, requested: unknown): { sessionId?: string; refusal?: string } {
  if (caller === undefined || caller === '') {
    return { refusal: 'no calling session for this tool call, so there is no queue to inject into' }
  }
  if (requested === undefined || requested === null || requested === '') return { sessionId: caller }
  if (typeof requested !== 'string') return { refusal: 'targetSessionId must be a session id string' }
  if (safeSessionKey(requested) !== safeSessionKey(caller)) return { refusal: INJECT_SCOPE_REFUSAL }
  return { sessionId: caller }
}

/** Contexts that already own a `cortex:prompts` registration (duplicate = host throw). */
const registeredContexts = new WeakSet<object>()

/** One service per state root: the tools, the endpoints and the seam share ONE queue. */
const instances = new Map<string, PromptsService>()

export function promptsService(deps: ModuleDeps): PromptsService {
  const existing = instances.get(deps.store.root)
  if (existing !== undefined) return existing
  const created = new PromptsService(deps)
  instances.set(deps.store.root, created)
  return created
}

/** Drop the cached service for one root (teardown, and tests that reuse a root). */
export function resetPromptsService(root: string): void {
  instances.delete(root)
}

/** The module's refusal shape: a sentence (neutralized) plus a stable code. */
function nope(message: string, code = 'refused'): PromptOutcome {
  return { ok: false, message: neutralize(message), code }
}

/** Re-exported so the tools/UI read the same numbers the renderer enforces. */
export const LIMITS = { STICKY_MAX_TURNS, ONCE_TURNS, QUEUE_MAX_ROWS, PROMPT_BODY_CHARS, PROMPTS_BLOCK_CHARS, MANUAL_TEXT_CHARS }
