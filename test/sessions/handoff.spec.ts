/**
 * Handoff Protocol unit tests — pure renderer and budget rules.
 * No host, no filesystem: `renderHandoff` is the surface under test.
 */
import { describe, expect, it } from 'vitest'
import {
  renderHandoff,
  HANDOFF_BUDGET_CHARS,
  type HandoffInput,
} from '../../src/host/modules/sessions/handoff.ts'

const baseInput: HandoffInput = {
  label: '[dsh-cortex · handoff]',
  today: '2026-09-15',
  todos: [],
  logs: [],
}

describe('renderHandoff — structure', () => {
  it('includes all four sections even when the store is empty', () => {
    const result = renderHandoff(baseInput)
    expect(result.suppressed).toBe(false)
    expect(result.text).toContain('### summary')
    expect(result.text).toContain('### what-changed')
    expect(result.text).toContain('### what-remains')
    expect(result.text).toContain('### blockers')
    // Empty store → honest placeholders
    expect(result.text).toContain('(no log entries)')
    expect(result.text).toContain('(none)')
    expect(result.text).toContain('(none surfaced)')
  })

  it('renders open todos under what-remains', () => {
    const input: HandoffInput = {
      ...baseInput,
      todos: [
        { id: 't-1', track: 'project', text: 'Fix the auth bug', done: false, createdAt: '2026-09-14' },
        { id: 't-2', track: 'work', text: 'Write the report', done: false, createdAt: '2026-09-14' },
      ],
    }
    const result = renderHandoff(input)
    expect(result.text).toContain('Fix the auth bug')
    expect(result.text).toContain('Write the report')
  })

  it('renders log entries under what-changed (newest last → reversed to newest first)', () => {
    const input: HandoffInput = {
      ...baseInput,
      logs: [{ scope: 'project', text: '2026-09-14\nold work\n2026-09-15\nnew work' }],
    }
    const result = renderHandoff(input)
    expect(result.text).toContain('new work')
    expect(result.text).toContain('old work')
    // newest work should appear before old work in the what-changed section
    const newIdx = result.text.indexOf('new work')
    const oldIdx = result.text.indexOf('old work')
    expect(newIdx).toBeLessThan(oldIdx)
  })

  it('shows an error line when a log read failed', () => {
    const input: HandoffInput = {
      ...baseInput,
      logs: [{ scope: 'daily', text: '', error: 'ENOENT' }],
    }
    const result = renderHandoff(input)
    expect(result.text).toContain('read failed: ENOENT')
  })

  it('includes custom blockers text when provided', () => {
    const input: HandoffInput = {
      ...baseInput,
      blockers: 'Sandbox blocks TCP to embedded PG\nwaiting for operator unlock',
    }
    const result = renderHandoff(input)
    expect(result.text).toContain('Sandbox blocks TCP')
    expect(result.text).toContain('waiting for operator unlock')
  })

  it('shows (none surfaced) when no blockers are provided', () => {
    const result = renderHandoff(baseInput)
    expect(result.text).toContain('(none surfaced)')
  })

  it('includes the honest label from input.label', () => {
    const result = renderHandoff({ ...baseInput, label: '[my-test-label]' })
    expect(result.text.startsWith('[my-test-label]')).toBe(true)
  })
})

describe('renderHandoff — budget', () => {
  it('returns suppressed=true when the budget is too small to hold the framing', () => {
    const result = renderHandoff({ ...baseInput, budget: 20 })
    expect(result.suppressed).toBe(true)
    expect(result.text).toBe('')
  })

  it('respects a custom budget', () => {
    const result = renderHandoff({ ...baseInput, budget: 4000 })
    expect(result.text.length).toBeLessThanOrEqual(4000)
    expect(result.suppressed).toBe(false)
  })

  it('truncates long todo lists to the limit', () => {
    // orderForDigest sorts by createdAt ascending — all same day, so id breaks ties:
    // t-0, t-1, t-10, t-11, t-2, t-3, t-4, t-5, … → first 6 = 0,1,10,11,2,3
    const todos = Array.from({ length: 12 }, (_, i) => ({
      id: `t-${String(i).padStart(2, '0')}`,
      track: 'daily' as const,
      text: `Item ${String(i)}`,
      done: false,
      createdAt: '2026-09-14T00:00:00Z',
    }))
    const result = renderHandoff({ ...baseInput, todos })
    // First 6 shown, 6 more counted
    expect(result.text).toContain('Item 0')
    expect(result.text).toContain('Item 1')
    expect(result.text).toContain('[… 6 more')
    // Item 12+ not shown (not in the truncated tail)
    expect(result.text).not.toContain('Item 12')
  })

  it('defaults to HANDOFF_BUDGET_CHARS when no budget is passed', () => {
    const result = renderHandoff(baseInput)
    expect(result.text.length).toBeLessThanOrEqual(HANDOFF_BUDGET_CHARS)
  })
})
