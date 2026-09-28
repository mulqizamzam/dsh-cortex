/**
 * The progress service: adapts the store to the pure collector in `report.ts`.
 *
 * Two things are decided here rather than in the renderer:
 *  - "newest" means `createdAt` descending. The store's own listing is ordered
 *    for injection (importance first), which is the wrong order for "what
 *    changed recently", so the re-sort happens on this side of the seam;
 *  - a read that fails contributes its error string instead of an empty array,
 *    which is what lets the report say "the project log could not be read"
 *    rather than silently reporting nothing (P2/P4).
 */
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import { isoDate } from '../../../lib/ids.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import type { Entry, ModuleDeps, TodoItem } from '../../types.ts'
import { collectProgress, PROGRESS_BUDGET_CHARS, PROGRESS_ENTRY_LIMIT, PROGRESS_LOG_DAYS } from './report.ts'
import type { ProgressResult, ProgressSource } from './report.ts'
import { sharedTaskScopes, cwdOf } from '../todo/scope.ts'
import type { TaskScopeCache } from '../todo/scope.ts'

export interface ProgressServiceOptions {
  deps: ModuleDeps
  scopes?: TaskScopeCache
  /** Injectable clock: a day is a local day, same rule as the store's file names. */
  now?: () => Date
}

export class ProgressService {
  readonly deps: ModuleDeps
  private readonly scopes: TaskScopeCache
  private readonly clock: () => Date

  constructor(options: ProgressServiceOptions) {
    this.deps = options.deps
    this.scopes = options.scopes ?? sharedTaskScopes()
    this.clock = options.now ?? ((): Date => new Date())
  }

  private get store() {
    return this.deps.store
  }

  async pidFor(agent: unknown): Promise<string | undefined> {
    return (await this.scopes.resolve(cwdOf(agent))).pid
  }

  /** The source object `collectProgress` reads through — one place, testable. */
  source(): ProgressSource {
    const store = this.store
    const cfg = () => this.deps.cfg()
    return {
      today: () => isoDate(this.clock()),
      label: () => cfg().injectLabel,
      pid: async (agent: unknown) => await this.pidFor(agent),
      listTodos: async (pid?: string): Promise<TodoItem[]> => {
        const result = await store.listTodos({ openOnly: true, ...(pid === undefined ? {} : { pid }) })
        if (!result.ok) {
          this.deps.warn(`progress: todo read failed (${result.error})`)
          return []
        }
        return result.data
      },
      readLog: async (scope, pid?: string) => {
        const result = await store.logRead({ scope, lastDays: PROGRESS_LOG_DAYS, ...(pid === undefined ? {} : { pid }) })
        if (!result.ok) return { text: '', error: result.error }
        return { text: result.data.text }
      },
      listEntries: async (pid?: string) => {
        if (pid === undefined) return [] as Entry[]
        const result = await store.listEntries({ track: 'project', pid, archived: false })
        if (!result.ok) {
          this.deps.warn(`progress: entry read failed (${result.error})`)
          return [] as Entry[]
        }
        return [...result.data.entries]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
          .slice(0, PROGRESS_ENTRY_LIMIT)
      },
    }
  }

  async report(agent: unknown): Promise<ProgressResult> {
    return await collectProgress(this.source(), agent)
  }

  tool(): ToolDefinition {
    return defineTool({
      name: 'cortex_progress_report',
      description:
        `Compose a status report out of what the plugin already stores: open todos, the last ${String(PROGRESS_LOG_DAYS)} log days, `
        + `and the ${String(PROGRESS_ENTRY_LIMIT)} newest project entries. Read-only and capped at ${String(PROGRESS_BUDGET_CHARS)} characters. `
        + 'It summarises nothing on its own — an empty store produces an empty report, and truncated sections say so.',
      parameters: { type: 'object', properties: {} },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_args: Record<string, unknown>, value: never) => text(value) },
      execute: async (_args: never, execution: { agent?: unknown }) => {
        const result = await this.report(execution?.agent)
        return neutralizeDeep({
          status: 'ok',
          report: result.text,
          chars: result.text.length,
          lines: result.lines,
          omitted: result.omitted,
          truncated: result.truncated,
        })
      },
    } as never)
  }
}
