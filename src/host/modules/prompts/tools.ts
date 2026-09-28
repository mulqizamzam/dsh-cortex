/**
 * M4 · the five prompt tools (DESIGN §4).
 *
 * Output shape follows the M2/M3 convention: a status token, one honest sentence,
 * and only as much data as a model needs — a listing reports `bodyChars`, not the
 * body, because a library read must not become a context dump. Every value
 * leaving here passes `neutralizeDeep` at this render edge (P9 / host issue-class
 * #53: a brace pair in model-visible text throws inside the host prompt renderer
 * and deadlocks the session).
 *
 * No description or parameter description carries a brace pair: they are
 * model-visible too, and they are static by construction here.
 *
 * The two gates that define this module:
 *  - `cortex_prompt_save` NEVER writes the library. It files a proposal
 *    (`pending/<id>.json`, kind `prompt`); only the human panel turns it into a
 *    saved workflow (DESIGN §4, P3).
 *  - `cortex_prompt_inject` reaches the CALLING session's queue only
 *    (see `resolveAgentInjectTarget` in service.ts).
 */
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralize, neutralizeDeep } from '../../../lib/sanitize.ts'
import { LIMITS, resolveAgentInjectTarget, sessionIdOf } from './service.ts'
import type { PromptsService } from './service.ts'
import type { PromptRow } from './queue.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: unknown }

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

/** Lines in a `cortex_prompt_list` answer (the panel shows everything). */
export const TOOL_LIST_LINES = 40

/** One library row, as a model sees it: title and size, never the body. */
function listLine(row: { id: string; title: string; category?: string; enabled: boolean; body: string; updatedAt: string }): string {
  const category = typeof row.category === 'string' && row.category !== '' ? ` [${clampText(neutralize(row.category), 40)}]` : ''
  return `- ${row.id}${category}${row.enabled ? '' : ' (disabled)'} "${clampText(neutralize(row.title), 80)}" — ${String(row.body.length)} chars, updated ${row.updatedAt}`
}

/** The queue, as a model sees it: what is still owed, and for how long. */
export function queueLines(rows: readonly PromptRow[]): string[] {
  return rows.map(row => `- ${row.mode} ${row.promptId === '' ? 'typed text' : row.promptId}: "${clampText(neutralize(row.title), 60)}" — ${String(row.rounds)} round${row.rounds === 1 ? '' : 's'} left`)
}

export function promptTools(svc: PromptsService): ToolDefinition[] {
  const off = (): Record<string, unknown> => neutralizeDeep({ status: 'refused', message: svc.disabledMessage })

  const list = defineTool({
    name: 'cortex_prompt_list',
    description:
      'List the saved workflow prompts the user can inject: id, category, title and body size. Read-only. The body itself is not included — '
      + 'call cortex_prompt_get for one prompt. Injecting a saved prompt into this session is cortex_prompt_inject.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Only prompts in this category.' },
        includeDisabled: { type: 'boolean', description: 'Include prompts the user switched off. Default true.' },
      },
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, _execution: Execution) => {
      if (!svc.enabled) return off()
      const a = (args ?? {}) as Args
      const includeDisabled = a.includeDisabled !== false
      const category = typeof a.category === 'string' && a.category.trim() !== '' ? a.category.trim() : undefined
      const docs = await svc.list({ category, ...(includeDisabled ? {} : { enabled: true }) })
      const lines = docs.map(listLine)
      const shown = lines.slice(0, TOOL_LIST_LINES)
      return neutralizeDeep({
        status: 'ok',
        count: docs.length,
        lines: shown,
        more: lines.length - shown.length,
        summary: docs.length === 0
          ? 'the prompt library is empty; the user can save one, or approve a pending proposal'
          : `${String(docs.length)} saved prompt${docs.length === 1 ? '' : 's'}${lines.length > shown.length ? ` (first ${String(shown.length)} shown)` : ''}`,
      })
    },
  } as never)

  const get = defineTool({
    name: 'cortex_prompt_get',
    description: 'Read one saved prompt in full by its id, including the body, plus its enabled state. Read-only.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The 12-character prompt id from cortex_prompt_list.' } },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, _execution: Execution) => {
      if (!svc.enabled) return off()
      const a = (args ?? {}) as Args
      const id = typeof a.id === 'string' ? a.id : ''
      const doc = await svc.get(id)
      if (doc === null) return neutralizeDeep({ status: 'not-found', message: `no saved prompt ${clampText(id, 40)} — cortex_prompt_list shows the ids` })
      return neutralizeDeep({
        status: 'ok',
        prompt: { ...doc, body: clampText(doc.body, 8000), bodyChars: doc.body.length },
        summary: `"${doc.title}" — ${String(doc.body.length)} chars, ${doc.enabled ? 'enabled' : 'disabled'}`,
      })
    },
  } as never)

  const save = defineTool({
    name: 'cortex_prompt_save',
    description:
      'Propose a reusable workflow prompt for the user library. This does NOT save it: it files a pending proposal the user approves or rejects '
      + 'in the Cortex panel, because the library is what gets injected into later turns. Use it when the user describes a procedure worth keeping.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name of the workflow, e.g. "release checklist".' },
        body: { type: 'string', description: 'The text to inject when the user calls it up later.' },
        category: { type: 'string', description: 'Optional grouping, e.g. "release", "review".' },
        reason: { type: 'string', description: 'Why this is worth keeping; shown to the user with the proposal.' },
      },
      required: ['title', 'body'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      if (!svc.enabled) return off()
      const a = (args ?? {}) as Args
      const result = await svc.proposeSave({
        title: typeof a.title === 'string' ? a.title : '',
        body: typeof a.body === 'string' ? a.body : '',
        ...(typeof a.category === 'string' && a.category.trim() !== '' ? { category: a.category } : {}),
        ...(typeof a.reason === 'string' && a.reason.trim() !== '' ? { reason: a.reason } : {}),
        ...(sessionIdOf(execution?.agent) === undefined ? {} : { sessionId: sessionIdOf(execution?.agent) }),
      })
      return neutralizeDeep({ status: result.ok ? 'pending' : 'refused', message: result.message, pendingId: result.pendingId ?? null })
    },
  } as never)

  const toggle = defineTool({
    name: 'cortex_prompt_toggle',
    description:
      'Switch one saved prompt on or off by id. An off prompt stays in the library, stops being injectable and leaves any queued injection. '
      + 'It does not edit or delete the text — only the user can save or delete library content.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The prompt id.' },
        enabled: { type: 'boolean', description: 'true to make it injectable again, false to park it.' },
      },
      required: ['id', 'enabled'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, _execution: Execution) => {
      if (!svc.enabled) return off()
      const a = (args ?? {}) as Args
      const result = await svc.toggle(a.id, a.enabled)
      return neutralizeDeep({ status: result.ok ? 'ok' : 'refused', message: result.message, prompt: result.doc ?? null })
    },
  } as never)

  const inject = defineTool({
    name: 'cortex_prompt_inject',
    description:
      'Queue a saved prompt into THIS session’s context: mode once injects it on the next assembly and stops; mode sticky keeps re-injecting it, '
      + `counting down and ending automatically after ${String(LIMITS.STICKY_MAX_TURNS)} renders with an honest expiry line; mode clear removes queued `
      + 'injections. It cannot touch another session, and it never pretends to be the user: the block is always labelled as a saved workflow.',
    parameters: {
      type: 'object',
      properties: {
        promptId: { type: 'string', description: 'The saved prompt to inject. Omit for typed text instead.' },
        text: { type: 'string', description: 'Text to inject that is not in the library (kept in the queue, never saved).' },
        mode: { type: 'string', enum: ['once', 'sticky', 'clear'], description: 'once = one render, sticky = countdown, clear = drop queued rows.' },
        targetSessionId: { type: 'string', description: 'Only your own session id is accepted in v1; anything else is refused.' },
      },
      required: ['mode'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      if (!svc.enabled) return off()
      const a = (args ?? {}) as Args
      const mode = a.mode === 'once' || a.mode === 'sticky' || a.mode === 'clear' ? a.mode : undefined
      if (mode === undefined) return neutralizeDeep({ status: 'refused', message: 'mode must be once, sticky or clear' })
      const caller = sessionIdOf(execution?.agent)
      const target = resolveAgentInjectTarget(caller, a.targetSessionId)
      if (target.refusal !== undefined) return neutralizeDeep({ status: 'refused', message: target.refusal })
      const result = await svc.inject({
        sessionId: target.sessionId ?? '',
        mode,
        ...(typeof a.promptId === 'string' && a.promptId !== '' ? { promptId: a.promptId } : {}),
        ...(typeof a.text === 'string' && a.text !== '' ? { text: a.text } : {}),
      })
      return neutralizeDeep({
        status: result.ok ? 'queued' : 'refused',
        message: result.message,
        session: caller ?? null,
        queue: queueLines(result.rows ?? []),
      })
    },
  } as never)

  return [list, get, save, toggle, inject]
}
