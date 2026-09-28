/**
 * The seven `cortex_memory_*` agent tools (DESIGN §4).
 *
 * Two rules hold here and nowhere else:
 * - descriptions and parameter descriptions carry no brace pairs and no data
 *   from user text: the host interpolates model-visible strings (#53).
 * - every handler is defensive. A wrong argument is a sentence, not an
 *   exception; `registerToolSafe` in `apply()` is what keeps a name collision
 *   from taking the boot down.
 *
 * Scope (which project, which branch) comes from the CALLING agent's session
 * cwd, so a tool can never write into somebody else's project by asking.
 */
import { neutralize } from '../../../lib/sanitize.ts'
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { deleteEntry, listEntries, moveEntry, remember, search, updateEntry } from './ops.ts'
import type { MemoryContext, OpResult } from './ops.ts'
import { memoryContext } from './runtime.ts'
import type { MemoryInjector } from './runtime.ts'
import { cwdOf, sessionIdOf } from './scope.ts'

/** Model-facing text of one result: prose first, fields kept for the panel. */
function shape<T>(result: OpResult<T>, prose: (value: T) => string): Record<string, unknown> {
  if (result.ok === false) return { ok: false, error: result.error, text: result.error, ...(result.code ? { code: result.code } : {}) }
  const value = result.value
  const fields = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : { value }
  // `text` LAST: it is the prose the model reads, and a result field must not
  // silently replace it.
  return { ok: true, ...fields, text: neutralize(prose(value)) }
}

/** Output renderer: prose when there is prose, JSON otherwise. */
function renderValue(_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> {
  const record = value as unknown as Record<string, unknown>
  if (typeof record === 'object' && record !== null && typeof record.text === 'string') return text(record.text)
  return text(value)
}

const SCOPE_NOTE = ' The project and branch are taken from this session automatically.'

/** Args plus whatever the live session says about itself. */
function withSession(args: Record<string, unknown>, execution: unknown): Record<string, unknown> {
  const cwd = cwdOf((execution as { agent?: unknown } | undefined)?.agent)
  const sessionId = sessionIdOf((execution as { agent?: unknown } | undefined)?.agent)
  return { ...args, ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { sessionId }) }
}

export function buildTools(deps: ModuleDeps, injector: MemoryInjector): ToolDefinition[] {
  const context = (): MemoryContext => memoryContext(deps, injector.scopes, injector.tokens)
  // A write invalidates the memoised block, so the next assembly is fresh: the
  // session that just stored a memory sees it on its own next turn.
  const afterWrite = (): void => {
    injector.invalidate()
  }

  const rememberTool = defineTool({
    name: 'cortex_memory_remember',
    description:
      `Propose one long-term memory entry for later sessions. Unless the plugin config memory.autoAccept is on, this does NOT store anything: it creates a pending proposal a human approves in the Cortex panel, so the AI never writes its own memory (P3). Tracks: user = about the person, global = applies everywhere, project = this repository only.${SCOPE_NOTE} Keep it one short factual sentence.`,
    parameters: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: ['user', 'global', 'project'] },
        content: { type: 'string' },
        importance: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        branches: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
      required: ['track', 'content'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>, execution: unknown) => {
      const result = await remember(context(), withSession(args, execution))
      if (result.ok === true) afterWrite()
      // The op's own note is the honest sentence (it also names a clamp), so the
      // tool does not invent a shorter one that would hide it.
      return shape(result, value => value.note)
    },
  } as never)

  const searchTool = defineTool({
    name: 'cortex_memory_search',
    description:
      'Search stored memories by words: substring plus token matching over the user, global and current project tracks, ranked locally (no embeddings). Returns short snippets inside the configured character cap. Use it before answering anything about earlier sessions, decisions or conventions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tracks: { type: 'array', items: { type: 'string', enum: ['user', 'global', 'project'] } },
        project: { type: 'boolean' },
        includeArchive: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>, execution: unknown) => {
      const result = await search(context(), withSession(args, execution))
      return shape(result, value => (value.candidates === 0
        ? `${value.text}\n(0 matches; nothing was archived or deleted by this call.)`
        : value.text))
    },
  } as never)

  const listTool = defineTool({
    name: 'cortex_memory_list',
    description:
      'List stored memories with ids, track, importance and branch scope. By default it shows every branch scope; set branchOnly to see only what would be injected on this branch. Archived entries are hidden unless asked for.',
    parameters: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: ['user', 'global', 'project'] },
        branchOnly: { type: 'boolean' },
        archived: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>, execution: unknown) => {
      const result = await listEntries(context(), withSession(args, execution))
      return shape(result, value => value.text)
    },
  } as never)

  const archiveTool = defineTool({
    name: 'cortex_memory_archive',
    description:
      'Move one memory out of the injected set by id (found with cortex_memory_search or list). Nothing is deleted: archived entries stay on disk and remain searchable, they simply stop being injected. Prefer this over delete.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>, execution: unknown) => {
      const result = await moveEntry(context(), withSession(args, execution), 'archive')
      if (result.ok === true) afterWrite()
      return shape(result, value => `Archived memory ${value.id}; it no longer shows in context but is still searchable with includeArchive.`)
    },
  } as never)

  const restoreTool = defineTool({
    name: 'cortex_memory_restore',
    description: 'Put one archived memory back into the injected set, by id. The entry content is untouched (restore is the reverse of archive).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>, execution: unknown) => {
      const result = await moveEntry(context(), withSession(args, execution), 'restore')
      if (result.ok === true) afterWrite()
      return shape(result, value => `Restored memory ${value.id}; it can be injected again from the next turn.`)
    },
  } as never)

  const deleteTool = defineTool({
    name: 'cortex_memory_delete',
    description:
      'Permanently remove one memory by id. Two steps by design: the first call names the entry and returns a single-use token; the second call must present that token. Without the token nothing is deleted, and ids are the only way in — text never selects an entry for deletion.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, confirm: { type: 'string' } },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>, execution: unknown) => {
      const result = await deleteEntry(context(), withSession(args, execution), injector.tokens)
      if (result.ok === true) afterWrite()
      return shape(result, value => (value.deleted === true
        ? 'Entry deleted. This is not reversible; the pending log keeps the audit trail.'
        : String(value.warning ?? 'Confirmation required.')))
    },
  } as never)

  const updateTool = defineTool({
    name: 'cortex_memory_update',
    description:
      `Change one stored memory by id: content, importance (1 to 5), tags, or branch scope. Passing an empty branches array clears the branch scope, making the entry apply everywhere.${SCOPE_NOTE}`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        importance: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        branches: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: renderValue },
    execute: async (args: Record<string, unknown>, execution: unknown) => {
      const result = await updateEntry(context(), withSession(args, execution))
      if (result.ok === true) afterWrite()
      return shape(result, value => `Updated memory ${value.id} (importance ${value.importance}, track ${value.track}).`)
    },
  } as never)

  // Approving and rejecting proposals is the panel's job (P3); the memory
  // module exposes those two decisions as RPC endpoints only — see endpoints.ts.

  return [rememberTool, searchTool, listTool, archiveTool, restoreTool, deleteTool, updateTool]
}
