/**
 * Decision tools: index logs, search, list, and link decisions to memory.
 *
 * Output shape: neutralized at the render edge (P9), brace-free descriptions.
 * Every tool returns a `text` field a model can read directly, so the surface is
 * useful without the caller having to reshape the structured fields.
 */
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { HostAgent, ToolDefinition } from '../../dsh.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { callerSessionId } from '../rooms/service.ts'
import type { DecisionService } from './service.ts'
import { LINK_MAX } from './service.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: unknown }

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

/** Read an optional trimmed string argument. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function decisionTools(svc: DecisionService): ToolDefinition[] {
  const indexLogs = defineTool({
    name: 'cortex_decision_index_logs',
    description:
      'Parse [decision] tagged lines from recent logs and store structured decision records '
      + '(context, options, chosen, rationale, owner, tags). scope "project" indexes the current project log; '
      + 'scope "daily" indexes cross-project. Field names are read in several languages (options/opsi, chosen/chose, '
      + 'rationale/because/alasan, owner/by) and separators may be pipes or semicolons. Already-stored decisions are '
      + 'skipped, so re-running is safe; pass reindex true to record fresh copies anyway. Each new decision is linked to '
      + 'the memory entries it mentions; pass linkMemories false to skip that. Returns counts and any parse errors.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'daily'], description: 'Which log to scan.' },
        pid: { type: 'string', description: 'Project id (required for scope project).' },
        lastDays: { type: 'number', description: 'Window size in days. Default 7.' },
        reindex: { type: 'boolean', description: 'Passing true forces fresh copies for every line, skipping the dedup check.' },
        linkMemories: { type: 'boolean', description: 'Passing false stores the decisions without linking memory entries.' },
      },
      required: ['scope'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const scope = a.scope === 'project' || a.scope === 'daily' ? a.scope : undefined
      if (scope === undefined) return neutralizeDeep({ status: 'refused', message: 'scope must be project or daily' })
      const pid = str(a.pid)
      const lastDays = typeof a.lastDays === 'number' ? Math.floor(a.lastDays) : undefined
      const owner = callerSessionId((execution as { agent?: HostAgent } | undefined)?.agent) ?? 'user'
      const result = await svc.indexLogLines({ scope, pid, lastDays, owner, reindex: a.reindex === true, linkMemories: a.linkMemories !== false })
      const parts = [`${String(result.indexed)} decision(s) indexed`]
      if (result.skipped > 0) parts.push(`${String(result.skipped)} already stored (skipped)`)
      if (result.linked > 0) parts.push(`${String(result.linked)} memory link(s) attached`)
      return neutralizeDeep({
        status: result.indexed > 0 ? 'indexed' : 'nothing-to-index',
        indexed: result.indexed,
        skipped: result.skipped,
        linked: result.linked,
        errors: result.errors,
        text: `${parts.join(', ')}${result.errors.length > 0 ? ` — ${String(result.errors.length)} line(s) could not be parsed` : ''}`,
      })
    },
  } as never)

  const search = defineTool({
    name: 'cortex_decision_search',
    description:
      'Search stored decisions by query text, with optional project and tag filters. Returns a relevance-scored list '
      + 'of decisions plus a readable rendering of the same hits. An empty query lists everything in scope.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Empty returns all decisions in scope.' },
        pid: { type: 'string', description: 'Filter by project id.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter: must have ALL listed tags.' },
        limit: { type: 'number', description: 'Max results. Default 50.' },
      },
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Args
      const query = typeof a.query === 'string' ? a.query.trim() : ''
      const pid = str(a.pid)
      const tagsRaw = a.tags
      const tags: string[] | undefined = Array.isArray(tagsRaw)
        ? tagsRaw.filter((t: unknown): t is string => typeof t === 'string').map(t => t.trim()).filter(t => t !== '')
        : undefined
      const limit = typeof a.limit === 'number' ? Math.floor(a.limit) : undefined
      const result = await svc.search({ query, pid, tags, limit })
      return neutralizeDeep({
        status: 'ok',
        total: result.total,
        hits: result.hits,
        text: result.text,
      })
    },
  } as never)

  const list = defineTool({
    name: 'cortex_decision_list',
    description:
      'List stored decisions newest-first with a readable rendering: context, options, chosen, why, owner, tags and the '
      + 'memory entries each one is linked to. Use it to browse, or to find the decision id that cortex_decision_link needs.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'string', description: 'Filter by project id; omit for cross-project decisions.' },
        limit: { type: 'number', description: 'Max decisions to render. Default 50.' },
      },
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Args
      const result = await svc.list({ pid: str(a.pid), limit: typeof a.limit === 'number' ? Math.floor(a.limit) : undefined })
      return neutralizeDeep({
        status: 'ok',
        total: result.total,
        decisions: result.decisions,
        text: result.text,
      })
    },
  } as never)

  const link = defineTool({
    name: 'cortex_decision_link',
    description:
      'Attach memory entry ids to a stored decision, so the decision points back at the memory it came from. Indexing '
      + 'does this automatically from the wording; use this tool when you know two things are the same and the words did '
      + `not match. Ids come from cortex_memory_list (entries) and cortex_decision_list (decisions). At most ${String(LINK_MAX)} links are kept per decision.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Decision id to update.' },
        entryIds: { type: 'array', items: { type: 'string' }, description: 'Memory entry ids to attach; existing links are kept.' },
        pid: { type: 'string', description: 'Project id the decision lives under, when it is project-scoped.' },
      },
      required: ['id', 'entryIds'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Args
      const id = str(a.id)
      if (id === undefined) return neutralizeDeep({ status: 'refused', message: 'id is required: a decision id from cortex_decision_list' })
      const entryIds = Array.isArray(a.entryIds) ? a.entryIds.filter((x: unknown): x is string => typeof x === 'string') : []
      if (entryIds.length === 0) return neutralizeDeep({ status: 'refused', message: 'entryIds must name at least one memory entry id' })
      const result = await svc.link({ id, entryIds, pid: str(a.pid) })
      return neutralizeDeep({
        status: result.ok ? 'linked' : 'refused',
        message: result.message,
        linkedEntries: result.decision?.linkedEntries ?? null,
      })
    },
  } as never)

  return [indexLogs, search, list, link]
}
