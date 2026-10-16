/**
 * E2E: a relative `stateRoot` must not relocate plugin state into the process cwd.
 *
 * `resolveConfig` accepted any string and `boot` used it verbatim, so
 * `stateRoot: '~/dsh-cortex'` became a path relative to whatever cwd the host
 * happened to have — creating a literal `~` directory beside the user's work and
 * orphaning every byte of plugin state from the documented
 * "delete <DSH_HOME>/dsh-cortex and it is gone" contract.
 *
 * The test runs the boot with the process cwd moved into a throwaway directory,
 * so a regression deposits its `~` directory there instead of in the repository.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../../src/host/index.ts'
import { getDelegateService } from '../../src/host/modules/delegate/index.ts'
import type { CortexStore } from '../../src/host/store.ts'
import type { ToolDefinition } from '../../src/host/dsh.ts'

let home = ''
let scratchCwd = ''
let previousCwd = ''
let tools = new Map<string, ToolDefinition>()
let pluginStore: CortexStore

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-cortex-e2e-home-'))
  scratchCwd = await mkdtemp(join(tmpdir(), 'dsh-cortex-e2e-cwd-'))
  previousCwd = process.cwd()
  process.chdir(scratchCwd)

  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
      get: (name: string) => tools.get(name),
    },
    agents: { get: () => undefined, roots: () => [] },
    get(name: string) {
      if (name === 'dshHomePath') return (...segments: string[]) => join(home, ...segments)
      return undefined
    },
    inject: (_services: string[], callback: (context: unknown) => void) => { callback(ctx) },
    on: () => () => {},
    effect: (callback: () => unknown) => { callback(); return () => {} },
  } as never

  apply(ctx, { stateRoot: '~/dsh-cortex' } as never)

  const svc = getDelegateService()
  if (svc === null) throw new Error('delegate service was not bound by apply()')
  pluginStore = (svc as unknown as { deps: { store: CortexStore } }).deps.store
  await pluginStore.init()
})

afterAll(async () => {
  process.chdir(previousCwd)
  await rm(home, { recursive: true, force: true }).catch(() => {})
  await rm(scratchCwd, { recursive: true, force: true }).catch(() => {})
})

async function runTool(name: string): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return await tool.execute({} as never, { signal: new AbortController().signal }) as Record<string, unknown>
}

describe('E2E: a relative stateRoot is refused, not resolved against the cwd', () => {
  it('creates no literal ~ directory in the working directory', () => {
    console.log(`E2E STATEROOT tildeDirExists=${String(existsSync(join(scratchCwd, '~')))}`)
    expect(existsSync(join(scratchCwd, '~'))).toBe(false)
  })

  it('falls back to the documented <DSH_HOME>/dsh-cortex root', async () => {
    const status = await runTool('cortex_status')
    console.log(`E2E STATEROOT reported=${String(status.stateRoot)} expected=${join(home, 'dsh-cortex')}`)
    expect(status.stateRoot).toBe(join(home, 'dsh-cortex'))
  })
})
