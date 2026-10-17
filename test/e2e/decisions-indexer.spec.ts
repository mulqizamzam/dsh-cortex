/**
 * E2E proof: the two decisions-indexer read-side gaps that the marker-tolerance
 * case in `prove-fixes.spec.ts` does not cover.
 *
 * The unit tests in `test/decisions/indexer-gaps.spec.ts` call
 * `svc.indexLogLines` directly. This file goes through the tool a session
 * actually calls — `cortex_decision_index_logs` — so the proof covers the real
 * parameter surface, the real defaults and the real return shape.
 *
 * Both defects are silent-data-loss shapes: the run reports a clean result while
 * a decision that was in the log never reaches the store.
 *
 *   B. DEDUP IDENTITY. `decisionKey` was (context, chosen) only, so a genuinely
 *      different decision sharing those two fields was discarded as "already
 *      stored": indexed 0, skipped 1, no error.
 *   C. TRUNCATED READ. `store.logRead` cuts its text at
 *      `caps.searchResultChars` (8000) and appends a `[… truncated]` marker. The
 *      indexer split that text as if every line were complete, so a decision
 *      past the cut produced a clean-looking "found nothing" run with an empty
 *      `errors` array.
 *
 * One `apply()` per file, on purpose: module services are singletons bound to
 * the state root of the boot that created them, so a second apply would reuse
 * the previous root. Both cases below write the SAME file (the tool takes no
 * date), each immediately before the run that must read it, so neither case
 * depends on the other having run first.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../../src/host/index.ts'
import { getDelegateService } from '../../src/host/modules/delegate/index.ts'
import { DEFAULT_CONFIG } from '../../src/host/config.ts'
import { isoDate } from '../../src/lib/ids.ts'
import type { CortexStore } from '../../src/host/store.ts'
import type { ToolDefinition } from '../../src/host/dsh.ts'

let root = ''
let tools: Map<string, ToolDefinition>
let pluginStore: CortexStore

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-cortex-e2e-decindex-'))
  tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
      get: (name: string) => tools.get(name),
    },
    agents: { get: () => undefined, roots: () => [] },
    get(name: string) {
      if (name === 'dshHomePath') return (...segments: string[]) => join(root, ...segments)
      return undefined
    },
    inject: (services: string[], callback: (context: unknown) => void) => {
      if (services.includes('connection')) {
        (ctx as { connection?: unknown }).connection = { rpc: { handle: () => () => {} } }
      }
      callback(ctx)
    },
    on: () => () => {},
    effect: (callback: () => unknown) => { callback(); return () => {} },
  } as never

  apply(ctx, {
    stateRoot: root,
    delegation: { ...DEFAULT_CONFIG.delegation, enabled: true, runners: {} },
  } as never)

  const svc = getDelegateService()
  if (svc === null) throw new Error('delegate service was not bound by apply()')
  pluginStore = (svc as unknown as { deps: { store: CortexStore } }).deps.store
  await pluginStore.init()
})

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

async function runTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return await tool.execute(args as never, { signal: new AbortController().signal }) as Record<string, unknown>
}

/**
 * Write today's daily log — the only file `logRead` sees for scope 'daily' in a
 * root this test owns. Called immediately before each index run, because both
 * cases reuse that one path.
 */
async function writeDailyLog(lines: string[]): Promise<void> {
  const file = pluginStore.paths.dailyLog(isoDate(new Date()))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
}

describe('cortex_decision_index_logs, through the real tool surface', () => {
  it('does not discard a different decision that shares context and chosen', async () => {
    await writeDailyLog(['- [decision] same ctx | chosen: same | rationale: first reason'])
    const first = await runTool('cortex_decision_index_logs', { scope: 'daily' })
    console.log(`E2E DEDUP first indexed=${String(first.indexed)} skipped=${String(first.skipped)} errors=${JSON.stringify(first.errors ?? [])}`)
    expect(first.indexed).toBe(1)

    // Same context, same chosen, different rationale. Decision ids come from
    // `newId()` per parsed line, so this is a distinct record by every field
    // except the two the old key compared.
    await writeDailyLog(['- [decision] same ctx | chosen: same | rationale: second, entirely different reason'])
    const second = await runTool('cortex_decision_index_logs', { scope: 'daily' })
    console.log(`E2E DEDUP second indexed=${String(second.indexed)} skipped=${String(second.skipped)} errors=${JSON.stringify(second.errors ?? [])}`)
    expect(second.indexed).toBe(1)
    expect(second.skipped).toBe(0)

    // Both records must survive: a (context, chosen)-only key stored one and
    // reported the other as already stored.
    const stored = await pluginStore.listDecisions({})
    if (!stored.ok) throw new Error(`listDecisions failed: ${stored.error}`)
    const rationales = stored.data.map(decision => decision.rationale)
    console.log(`E2E DEDUP stored=${String(stored.data.length)} rationales=${JSON.stringify(rationales)}`)
    expect(rationales).toContain('first reason')
    expect(rationales).toContain('second, entirely different reason')
    expect(stored.data).toHaveLength(2)
  })

  it('reports the truncated read instead of a clean run when the decision sits past the cap', async () => {
    // ~19.6k characters of filler, so the 8000-character read cut falls far
    // inside the filler and the decision line beyond it is never examined.
    const filler = Array.from({ length: 400 }, (_, index) => `- filler line ${String(index)} ${'x'.repeat(30)}`)
    await writeDailyLog([...filler, '- [decision] beyond the cut | chosen: z | rationale: unreachable'])
    const result = await runTool('cortex_decision_index_logs', { scope: 'daily' })
    const errors = (result.errors ?? []) as unknown[]
    console.log(`E2E TRUNCATED indexed=${String(result.indexed)} skipped=${String(result.skipped)} errors=${JSON.stringify(errors)}`)
    // The decision sat past the cut, so nothing was indexed — and silence about
    // that is exactly the defect: the run looked clean while a decision line was
    // never examined.
    expect(result.indexed).toBe(0)
    expect(errors.length).toBeGreaterThan(0)
    expect(String(errors[0])).toContain('truncated')
  })
})
