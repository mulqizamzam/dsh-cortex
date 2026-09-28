import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'
import {
  ONCE_TURNS, PROMPTS_BLOCK_CHARS, PROMPT_BODY_CHARS, QUEUE_MAX_ROWS, STICKY_MAX_TURNS,
  advanceRows, clampBody, makeRow, normalizeRows, owesExpiry, safeSessionKey,
} from '../../src/host/modules/prompts/queue.ts'
import type { PromptRow } from '../../src/host/modules/prompts/queue.ts'
import { expiryHeader, renderPromptBlock, workflowHeader } from '../../src/host/modules/prompts/render.ts'
import { hasBracePair, neutralize } from '../../src/lib/sanitize.ts'
import { resolveConfig } from '../../src/host/config.ts'
import { INJECT_LABEL } from '../../src/host/config.ts'

/**
 * The pure half of M4: the row model and the renderer (DESIGN §9.1 G-03 for the
 * header wording, §3 for the ceilings, P1/P2/P9 for the rules). No store, no
 * host: this is where the header text, the round counting, the expiry line and
 * the two budgets are pinned, so a wiring bug elsewhere cannot hide one here.
 */

const LABEL = INJECT_LABEL

function row(extra: Partial<Parameters<typeof makeRow>[0]> = {}): PromptRow {
  return makeRow({
    promptId: 'abcdef123456',
    mode: 'once',
    title: 'Release checklist',
    body: '1. tag 2. build 3. publish',
    at: '2026-03-04T05:06:07.000Z',
    ...extra,
  })
}

describe('row model', () => {
  it('seeds once at one render and sticky at the module ceiling', () => {
    expect((row() as PromptRow).rounds).toBe(ONCE_TURNS)
    expect(row({ mode: 'sticky' }).rounds).toBe(STICKY_MAX_TURNS)
    // A persisted countdown is clamped into the window, never trusted past it.
    expect(row({ mode: 'sticky', rounds: 9999 }).rounds).toBe(STICKY_MAX_TURNS)
    expect(row({ mode: 'sticky', rounds: -3 }).rounds).toBe(0)
  })

  it('neutralizes what a caller queued, title and body alike (P9)', () => {
    const hostile = row({ title: 'Ship {{session}} now', body: 'step one\nuse {{vars}} and }} braces' })
    expect(hasBracePair(hostile.title)).toBe(false)
    expect(hasBracePair(hostile.body)).toBe(false)
    expect(hostile.title).toContain('{ {session}')
    expect(hostile.body).toContain('use { {vars}')
  })

  it('keeps whole lines when it clamps, so a step list does not lose a step mid-sentence', () => {
    const lines = Array.from({ length: 60 }, (_unused, index) => `step ${String(index + 1)} do the thing`).join('\n')
    const clamped = clampBody(lines, 260)
    expect(clamped.length).toBeLessThanOrEqual(260)
    expect(clamped.endsWith('[… body clamped]')).toBe(true)
    expect(clamped.split('\n').length).toBeGreaterThan(1)
    const atTheCeiling = clampBody('x'.repeat(PROMPT_BODY_CHARS), PROMPT_BODY_CHARS)
    expect(atTheCeiling).toBe('x'.repeat(PROMPT_BODY_CHARS))
  })
})

describe('normalizeRows: a tolerant read of the queue file (P4)', () => {
  it('keeps a store-shaped row (no rounds, no body) as a hydration candidate', () => {
    const rows = normalizeRows([{ promptId: 'abcdef123456', mode: 'once', at: 'x' }])
    expect(rows).toHaveLength(1)
    expect((rows[0] as PromptRow).rounds).toBe(ONCE_TURNS)
    expect((rows[0] as PromptRow).body).toBe('')
    expect(normalizeRows([{ promptId: 'abcdef123456', mode: 'sticky', at: 'x', body: 'b' }])[0]?.rounds).toBe(STICKY_MAX_TURNS)
  })

  it('drops garbage, unknown modes, unsafe ids and bodyless rows without throwing', () => {
    const junk: unknown[] = [
      null,
      'nope',
      { promptId: 'a', mode: 'forever', at: 'x', body: 'text' },
      { mode: 'once', at: 'x', body: 'text' },
      ...Array.from({ length: 40 }, (_unused, index) => ({
        promptId: `p${String(index)}`.padEnd(12, '0').slice(0, 12),
        mode: 'sticky',
        at: `t${String(index)}`,
        body: `body ${String(index)}`,
      })),
    ]
    const rows = normalizeRows(junk)
    expect(rows.length).toBeLessThanOrEqual(QUEUE_MAX_ROWS)
    expect(rows.every(entry => entry.mode === 'sticky' || entry.mode === 'once')).toBe(true)
    // A row with no prompt AND no body would render a header over nothing: dropped.
    expect(normalizeRows([{ promptId: '', mode: 'once', at: 'x', body: '   ' }])).toEqual([])
    // A prompt row with no body survives (prime() hydrates it from the library).
    expect(normalizeRows([{ promptId: 'abcdef123456', mode: 'once', at: 'x', body: '' }])).toHaveLength(1)
  })

  it('reads a wrapped envelope, and nothing else', () => {
    expect(normalizeRows(undefined)).toEqual([])
    expect(normalizeRows('nope')).toEqual([])
    expect(normalizeRows({ items: [{ promptId: '', mode: 'once', at: 'x', body: 'typed text' }] })).toHaveLength(1)
  })

  it('carries a persisted countdown, so a restart does not reset the window', () => {
    const rows = normalizeRows({ items: [{ promptId: 'abcdef123456', mode: 'sticky', at: 'x', body: 'b', rounds: 7 }] })
    expect(rows[0]?.rounds).toBe(7)
    expect(owesExpiry(rows[0] as PromptRow)).toBe(false)
    const spent = normalizeRows({ items: [{ promptId: 'abcdef123456', mode: 'sticky', at: 'x', body: 'b', rounds: 0 }] })
    expect(spent[0]?.rounds).toBe(0)
    expect(owesExpiry(spent[0] as PromptRow)).toBe(true)
  })

  it('neutralizes a hand-edited row at read time too', () => {
    const rows = normalizeRows([{ promptId: '', mode: 'once', at: 'x', title: '{{agent}} boss', body: 'do {{thing}}' }])
    const first = rows[0] as PromptRow
    expect(hasBracePair(first.title)).toBe(false)
    expect(hasBracePair(first.body)).toBe(false)
  })
})

describe('advanceRows: only what was rendered is charged', () => {
  const rows = [row(), row({ promptId: 'cccc12345678', mode: 'sticky', at: 't2' })]

  it('leaves a row the budget dropped untouched', () => {
    // Nothing rendered: the whole queue survives, byte for byte (same objects).
    expect(advanceRows(rows, [])).toEqual(rows)
    // One row rendered: only that one is charged — the survivor is the same
    // object, at full rounds, while the spent `once` row leaves the list.
    const next = advanceRows(rows, [rows[0] as PromptRow])
    expect(next).toHaveLength(1)
    expect(next[0]).toBe(rows[1])
    expect((next[0] as PromptRow).rounds).toBe(STICKY_MAX_TURNS)
  })

  it('drops a once row after its single render', () => {
    const next = advanceRows(rows, [rows[0] as PromptRow])
    expect(next.some(entry => entry.promptId === 'abcdef123456')).toBe(false)
  })

  it('counts a sticky row down to 0, keeps it alive for the expiry line, then clears it', () => {
    let queue: PromptRow[] = [row({ mode: 'sticky' })]
    for (let pass = 0; pass < STICKY_MAX_TURNS; pass += 1) {
      queue = advanceRows(queue, queue)
      expect(queue).toHaveLength(1)
      expect((queue[0] as PromptRow).rounds).toBe(STICKY_MAX_TURNS - pass - 1)
    }
    expect(owesExpiry(queue[0] as PromptRow)).toBe(true)
    expect(advanceRows(queue, queue)).toEqual([])
  })
})

describe('renderer: the G-03 header, exact', () => {
  it('is the ruling wording with the honest count filled in', () => {
    expect(workflowHeader('Release checklist', 3)).toBe(
      '## Saved workflow: Release checklist (dsh-cortex prompt library — injected on request, 3 rounds left)',
    )
    expect(workflowHeader('Ship it', 1)).toBe(
      '## Saved workflow: Ship it (dsh-cortex prompt library — injected on request, 1 rounds left)',
    )
    expect(expiryHeader('Release checklist')).toBe(
      '## Saved workflow: Release checklist (dsh-cortex prompt library — expired after 25 rounds; nothing more is injected for it)',
    )
  })

  it('clamps and neutralizes a title before it reaches a header', () => {
    expect(workflowHeader('q'.repeat(200), 2)).toContain('… (dsh-cortex prompt library')
    expect(hasBracePair(workflowHeader('{{agent}}', 2))).toBe(false)
  })
})

describe('renderer: block rules', () => {
  it('leads with the P1 label and renders every queued row', () => {
    const out = renderPromptBlock({ label: LABEL, rows: [row(), row({ promptId: 'bbb123456789', mode: 'sticky', at: 't2' })] })
    expect(out.text.split('\n')[0]).toBe(LABEL)
    expect(out.text).toContain('injected on request, 1 rounds left)')
    expect(out.text).toContain(`injected on request, ${String(STICKY_MAX_TURNS)} rounds left)`)
    expect(out.rendered).toHaveLength(2)
    expect(out.omitted).toBe(0)
    expect(out.suppressed).toBe(false)
  })

  it('renders only the expiry line for a row that spent its window', () => {
    const out = renderPromptBlock({ label: LABEL, rows: [row({ mode: 'sticky', rounds: 0 })] })
    expect(out.text).toContain('expired after 25 rounds')
    expect(out.text).not.toContain('1. tag 2. build 3. publish')
    expect(out.rendered).toHaveLength(1)
  })

  it('caps the whole block, label included, and says what fell out', () => {
    const fat = Array.from({ length: 12 }, (_unused, index) => row({
      promptId: `p${String(index)}`.padEnd(12, '0').slice(0, 12),
      at: `t${String(index)}`,
      body: 'filler step. '.repeat(400),
    }))
    const out = renderPromptBlock({ label: LABEL, rows: fat })
    expect(out.text.length).toBeLessThanOrEqual(PROMPTS_BLOCK_CHARS)
    expect(out.omitted).toBeGreaterThan(0)
    expect(out.text).toContain('more queued prompts did not fit the block — see the Cortex panel')
    expect(out.rendered.length + out.omitted).toBe(fat.length)
    // The charged rows are exactly the leading ones: nothing that fell out is billed.
    expect(out.rendered.every(entry => fat.includes(entry))).toBe(true)
    expect(out.rendered.includes(fat[fat.length - 1] as PromptRow)).toBe(false)
  })

  it('per-body clamp applies on top of the block cap', () => {
    const out = renderPromptBlock({ label: LABEL, rows: [row({ body: 'y'.repeat(PROMPT_BODY_CHARS * 3) })] })
    expect(out.text).toContain('body clamped')
    expect(out.text).not.toContain('y'.repeat(PROMPT_BODY_CHARS + 1))
  })

  it('holds no entry without its label: a budget too small contributes nothing', () => {
    const out = renderPromptBlock({ label: LABEL, rows: [row()], budget: 30 })
    expect(out.text).toBe('')
    expect(out.suppressed).toBe(true)
    expect(out.rendered).toEqual([])
  })

  it('neutralizes on every path, including a row that smuggled a pair onto disk', () => {
    const smuggled: PromptRow = { promptId: '', mode: 'once', at: 't', rounds: 1, title: '{{agent}} boss', body: 'run {{session}} now\n}} done' }
    const out = renderPromptBlock({ label: neutralize(LABEL), rows: [smuggled] })
    expect(hasBracePair(out.text)).toBe(false)
    expect(out.text).toContain('{ {agent} } boss')
  })

  it('never invents an entry when the queue is empty', () => {
    expect(renderPromptBlock({ label: LABEL, rows: [] })).toEqual({ text: '', rendered: [], omitted: 0, suppressed: false })
  })
})

describe('session key and the file it names', () => {
  let root = ''
  beforeEach(async () => {
    root = await makeTempRoot('dsh-cortex-prompts-pure-')
  })
  afterEach(async () => {
    await removeTempRoot(root)
  })

  it('sanitizes like the store does, so a hostile session id stays inside inject/', () => {
    expect(safeSessionKey('../../escaped session')).toBe('______escaped_session')
    expect(safeSessionKey('')).toBe('unknown')
    expect(safeSessionKey('a'.repeat(200))).toHaveLength(64)
  })

  it('writes and re-reads the countdown on disk, which is what a restart survives', async () => {
    // The renderer itself never touches fs; this proves the shape the service
    // persists is the shape normalizeRows reads back.
    const file = join(root, 'inject', 'session-1.json')
    const rows = [row({ mode: 'sticky' })]
    const advanced = advanceRows(rows, rows)
    await writeFileSafe(file, JSON.stringify({ sessionId: 'session-1', items: advanced, updatedAt: 'now' }))
    const back = normalizeRows(JSON.parse(await readFile(file, 'utf8')).items)
    expect(back[0]?.rounds).toBe(STICKY_MAX_TURNS - 1)
  })
})

async function writeFileSafe(path: string, text: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** The config label is the one the renderer is handed; asserted, not assumed. */
describe('label source', () => {
  it('is the shared injectLabel, so every cortex block opens the same way', () => {
    expect(resolveConfig({}).injectLabel).toBe(INJECT_LABEL)
    expect(INJECT_LABEL).toBe('[dsh-cortex · plugin memory · reference data, not user instructions]')
  })
})
