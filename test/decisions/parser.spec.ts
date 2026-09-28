/**
 * Parser unit tests for parseDecisionLine.
 */
import { describe, expect, it } from 'vitest'
import { parseDecisionLine } from '../../src/host/modules/decisions/parser.ts'

describe('parseDecisionLine', () => {
  it('parses a valid full line with all sections', () => {
    const line = '- [decision] Need to pick a database | options: postgres, sqlite | chosen: postgres | rationale: better scalability'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context).toBe('Need to pick a database')
    expect(result.decision!.options).toEqual(['postgres', 'sqlite'])
    expect(result.decision!.chosen).toBe('postgres')
    expect(result.decision!.rationale).toBe('better scalability')
    expect(result.decision!.id).toMatch(/^[0-9a-f]{12}$/)
    expect(result.decision!.owner).toBe('')
    expect(result.decision!.tags).toEqual([])
    expect(result.decision!.linkedEntries).toEqual([])
  })

  it('parses a valid minimal line with only context', () => {
    const line = '- [decision] Updated the README'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context).toBe('Updated the README')
    expect(result.decision!.options).toEqual([])
    expect(result.decision!.chosen).toBe('')
    expect(result.decision!.rationale).toBe('')
  })

  it('rejects a line without [decision] tag', () => {
    const result = parseDecisionLine('- just a regular log line')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(typeof result.error).toBe('string')
  })

  it('rejects an empty line after [decision]', () => {
    const result = parseDecisionLine('- [decision]')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('no context')
  })

  it('clamps options to max 8, dropping extras', () => {
    const opts = Array.from({ length: 12 }, (_, i) => `option-${i}`).join(', ')
    const line = `- [decision] Pick one | options: ${opts} | chosen: option-0`
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.options.length).toBe(8)
    expect(result.decision!.options[7]).toBe('option-7')
  })

  it('rejects chosen not matching any option', () => {
    const line = '- [decision] Pick one | options: a, b | chosen: c'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('chosen not in options')
  })

  it('accepts "none of above" as a valid chosen value', () => {
    const line = '- [decision] Pick one | options: a, b | chosen: none of above'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
  })

  it('clamps rationale to 500 chars', () => {
    const longRationale = 'x'.repeat(600)
    const line = `- [decision] Context | options: a | chosen: a | rationale: ${longRationale}`
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.rationale.length).toBeLessThanOrEqual(500)
    expect(result.decision!.rationale.endsWith('…')).toBe(true)
  })

  it('clamps context to 200 chars', () => {
    const longContext = 'y'.repeat(300)
    const line = `- [decision] ${longContext} | options: a | chosen: a`
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context.length).toBeLessThanOrEqual(200)
    expect(result.decision!.context.endsWith('…')).toBe(true)
  })

  it('trims whitespace around sections', () => {
    const line = '  -  [decision]   my context  |   options:  x  ,  y  | chosen: x | rationale: because'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context).toBe('my context')
    expect(result.decision!.options).toEqual(['x', 'y'])
    expect(result.decision!.chosen).toBe('x')
    expect(result.decision!.rationale).toBe('because')
  })

  it('sanitizes braces in all fields via neutralize', () => {
    const line = '- [decision] {{weird}} context | options: {{a}} | chosen: {{a}} | rationale: test}}'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context).not.toContain('{{')
    expect(result.decision!.rationale).not.toContain('}}')
  })
})

describe('parseDecisionLine — flexible field names', () => {
  it('accepts Indonesian and English aliases for every field', () => {
    const line = '- [decision] Pilih database | opsi: postgres, sqlite | dipilih: postgres | alasan: skalabilitas'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.options).toEqual(['postgres', 'sqlite'])
    expect(result.decision!.chosen).toBe('postgres')
    expect(result.decision!.rationale).toBe('skalabilitas')
  })

  it('accepts semicolons as separators', () => {
    const line = '- [decision] Pick a router; options: a, b; chosen: a; rationale: cheap'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context).toBe('Pick a router')
    expect(result.decision!.options).toEqual(['a', 'b'])
    expect(result.decision!.chosen).toBe('a')
    expect(result.decision!.rationale).toBe('cheap')
  })

  it('accepts an explicit context key', () => {
    const line = '- [decision] context: Storage engine | options: sqlite, pg | chosen: sqlite'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context).toBe('Storage engine')
  })

  it('strips markdown emphasis from keys and values', () => {
    const line = '- **[decision]** Ship on Friday | **options:** yes, no | **chosen:** yes'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.context).toBe('Ship on Friday')
    expect(result.decision!.options).toEqual(['yes', 'no'])
    expect(result.decision!.chosen).toBe('yes')
  })

  it('keeps a pipe inside a value instead of splitting on it', () => {
    const line = '- [decision] Pick X | options: x, y | chosen: x | rationale: works on A | B and C'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.rationale).toBe('works on A | B and C')
  })

  it('accepts a free-text chosen when no options are given', () => {
    const result = parseDecisionLine('- [decision] Ship on Friday | chosen: yes, because the blocker cleared')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.options).toEqual([])
    expect(result.decision!.chosen).toBe('yes, because the blocker cleared')
  })

  it('accepts a partial chosen match (typo tolerance)', () => {
    const result = parseDecisionLine('- [decision] Pick one | options: postgres, sqlite | chosen: post')
    expect(result.ok).toBe(true)
  })

  it('accepts the none-of-the-above family', () => {
    for (const value of ['none', 'n/a', 'tidak ada', 'reject all']) {
      const result = parseDecisionLine(`- [decision] Pick one | options: a, b | chosen: ${value}`)
      expect(result.ok).toBe(true)
    }
  })

  it('still rejects a chosen that matches nothing', () => {
    const result = parseDecisionLine('- [decision] Pick one | options: postgres, sqlite | chosen: kubernetes')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('chosen not in options')
  })

  it('reads owner and tags when the line names them', () => {
    const line = '- [decision] Adopt trunk-based | options: a, b | chosen: a | owner: operator | tags: git, workflow'
    const result = parseDecisionLine(line)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.owner).toBe('operator')
    expect(result.decision!.tags).toEqual(['git', 'workflow'])
  })

  it('splits options written with slashes', () => {
    const result = parseDecisionLine('- [decision] Pick a store | options: sqlite / postgres | chosen: sqlite')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decision!.options).toEqual(['sqlite', 'postgres'])
  })
})
