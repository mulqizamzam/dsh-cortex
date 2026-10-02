/**
 * The four todo tools (DESIGN §4). Results are a sentence plus the id, never a
 * dump (DESIGN §4), and every string that leaves here passes `neutralizeDeep`
 * at this render edge (P9 / host issue-class #53: a brace pair in model-visible
 * text throws inside the host prompt renderer and deadlocks the session).
 *
 * No description or parameter description may contain a brace pair: they are
 * model-visible too, and they are static by construction here.
 */
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { formatTodoList } from './digest.ts'
import type { TodoService } from './service.ts'
import type { TodoWriteResult } from './service.ts'
import { gateMutation } from '../mutate-gate.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: unknown }

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

/** Cap on a tool listing so `cortex_todo_list` cannot dump the whole store. */
export const TOOL_LIST_LINES = 40

export function todoTools(svc: TodoService): ToolDefinition[] {
  const add = defineTool({
    name: 'cortex_todo_add',
    description:
      'Add one todo to a durable 4-track list: life, work, daily, or project (project = the repository of the current session). '
      + 'Use it when the user asks to remember to do something, not for step-by-step planning inside this turn. '
      + 'due must be YYYY-MM-DD; anything else is refused rather than guessed.',
    parameters: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: ['life', 'work', 'daily', 'project'], description: 'Which bucket owns this todo.' },
        text: { type: 'string', description: 'One imperative line describing the work.' },
        important: { type: 'boolean', description: 'Rank first among undated items.' },
        urgent: { type: 'boolean', description: 'Rank first of all.' },
        due: { type: 'string', description: 'Due date as YYYY-MM-DD. Optional.' },
      },
      required: ['track', 'text'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const result = await svc.addTodo(a, execution?.agent)
      return neutralizeDeep({ status: result.ok ? 'added' : 'refused', message: result.message, todo: result.item ?? null })
    },
  } as never)

  const list = defineTool({
    name: 'cortex_todo_list',
    description:
      'List todos across the four tracks, open items first by default. Dated items come first ordered by due date, then urgent, '
      + 'then important, then age. Results are capped; the Cortex panel shows everything.',
    parameters: {
      type: 'object',
      properties: {
        tracks: {
          type: 'array',
          items: { type: 'string', enum: ['life', 'work', 'daily', 'project'] },
          description: 'Restrict to these tracks. Default: all four (project only when the session has a repository).',
        },
        openOnly: { type: 'boolean', description: 'Hide completed items. Default true.' },
      },
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const tracks = Array.isArray(a.tracks) ? a.tracks.filter((item): boolean => typeof item === 'string') : undefined
      const openOnly = a.openOnly === undefined ? true : a.openOnly === true
      const scope = await svc.scopeFor(execution?.agent)
      const items = await svc.allTodos({
        ...(tracks === undefined ? {} : { tracks: tracks as never }),
        ...(scope.pid === undefined ? {} : { pid: scope.pid }),
        openOnly,
      })
      const lines = formatTodoList(items, svc.today())
      const shown = lines.slice(0, TOOL_LIST_LINES)
      return neutralizeDeep({
        status: 'ok',
        count: items.length,
        openOnly,
        project: scope.pid === undefined ? null : scope.pid.slice(0, 8),
        lines: shown.map(line => clampText(line, 300)),
        more: lines.length - shown.length,
        summary: lines.length === 0
          ? 'no todos match'
          : `${String(items.length)} todo${items.length === 1 ? '' : 's'}${lines.length > shown.length ? ` (first ${String(shown.length)} shown)` : ''}`,
      })
    },
  } as never)

  const complete = defineTool({
    name: 'cortex_todo_complete',
    description: 'Mark one todo done by its id (from cortex_todo_list or the injected todo digest). Refuses unknown ids with a sentence. When mutate.confirmRequired is on, this is two steps: the first call returns a single-use token, the second must present it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The 12-character todo id.' },
        confirm: { type: 'string', description: 'Only when mutate.confirmRequired is on: the token from the first call.' },
      },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const gateRequired = svc.deps.cfg().mutate?.confirmRequired === true
      const id = typeof a.id === 'string' ? a.id.trim() : ''
      const gated = await gateMutation(gateRequired, `todo:complete:${id}`, a.confirm, `mark todo ${id} done`, async () =>
        svc.completeTodo(a.id, execution?.agent))
      if (gated.token !== undefined) return neutralizeDeep({ status: 'confirm-required', token: gated.token, warning: gated.warning })
      if (!gated.ok) return neutralizeDeep({ status: 'refused', message: gated.warning })
      const result = gated.result as TodoWriteResult
      return neutralizeDeep({ status: result.ok ? 'completed' : 'refused', message: result.message, todo: result.item ?? null })
    },
  } as never)

  const remove = defineTool({
    name: 'cortex_todo_remove',
    description: 'Delete one todo by id. Use cortex_todo_complete for finished work; this throws the record away. When mutate.confirmRequired is on, this is two steps: the first call returns a single-use token, the second must present it.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The 12-character todo id.' },
        confirm: { type: 'string', description: 'Only when mutate.confirmRequired is on: the token from the first call.' },
      },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const gateRequired = svc.deps.cfg().mutate?.confirmRequired === true
      const id = typeof a.id === 'string' ? a.id.trim() : ''
      const gated = await gateMutation(gateRequired, `todo:remove:${id}`, a.confirm, `permanently delete todo ${id}`, async () =>
        svc.removeTodo(a.id, execution?.agent))
      if (gated.token !== undefined) return neutralizeDeep({ status: 'confirm-required', token: gated.token, warning: gated.warning })
      if (!gated.ok) return neutralizeDeep({ status: 'refused', message: gated.warning })
      const result = gated.result as TodoWriteResult
      return neutralizeDeep({ status: result.ok ? 'removed' : 'refused', message: result.message })
    },
  } as never)

  return [add, list, complete, remove]
}
