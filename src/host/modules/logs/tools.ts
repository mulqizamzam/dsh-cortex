/**
 * The two log tools (DESIGN §4). Output is a sentence plus the bounded tail,
 * neutralized at this render edge (P9), and a refusal is a sentence the model
 * can act on — never a stack, never a silent success.
 *
 * G-06 lives in the description too: the tool says plainly that the AI writes
 * the line, because a model that believes the plugin logs by itself stops
 * calling it and the log quietly stops existing.
 */
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ToolDefinition } from '../../dsh.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { MAX_LAST_DAYS } from './service.ts'
import type { LogService } from './service.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: unknown }

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export function logTools(svc: LogService): ToolDefinition[] {
  const append = defineTool({
    name: 'cortex_log_append',
    description:
      'Append ONE capped line to a project or daily log. You author the content: nothing is recorded automatically and this plugin '
      + 'never summarises a session for you. Use it at the moment something durable happens (a decision, a fix, a blocker), not at '
      + 'the end of a turn. scope "project" stores under the repository of this session; scope "daily" is cross-project.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'daily'], description: 'Which log the line belongs to.' },
        text: { type: 'string', description: 'The line itself, one sentence, no leading dash.' },
      },
      required: ['scope', 'text'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const result = await svc.append(a, execution?.agent)
      return neutralizeDeep({
        status: result.ok ? 'logged' : 'refused',
        message: result.message,
        date: result.ref?.date ?? null,
        scope: result.ref?.scope ?? null,
        rolled: result.ref?.rolled === true,
        line: result.ref?.line ?? null,
      })
    },
  } as never)

  const read = defineTool({
    name: 'cortex_log_read',
    description:
      `Read a log: one day (date=YYYY-MM-DD) or a window of up to ${String(MAX_LAST_DAYS)} days ending today. `
      + 'Returns the newest lines, each already capped, oldest first; older lines are counted, not dropped silently.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'daily'], description: 'Which log to read.' },
        date: { type: 'string', description: 'A single day, YYYY-MM-DD. Overrides lastDays.' },
        lastDays: { type: 'number', description: `Window size, 1..${String(MAX_LAST_DAYS)}. Default 1 (today).` },
      },
      required: ['scope'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never, execution: Execution) => {
      const a = (args ?? {}) as Args
      const result = await svc.read(a, execution?.agent)
      if (!result.ok) return neutralizeDeep({ status: 'refused', message: result.message })
      return neutralizeDeep({
        status: 'ok',
        message: result.message,
        days: result.days ?? [],
        lines: result.lines ?? [],
        text: result.text ?? '',
      })
    },
  } as never)

  return [append, read]
}
