/**
 * M5 optimize — equivalence of the two changed helpers against FROZEN copies of
 * the pre-patch implementations (not re-derivations):
 *
 *   neutralize: the per-character `output += char` loop, verbatim from
 *     a260fc1;
 *   summarize:  the split/map/filter + `find(…) ?? [0]` + clampText chain,
 *     verbatim from a260fc1.
 *
 * Every case asserts the shipped function returns the SAME string as its
 * oracle. clampText itself is untouched and used by both sides, so it cannot
 * mask a difference.
 */
import { describe, expect, it } from 'vitest'
import { neutralize } from '../src/lib/sanitize.ts'
import { summarize } from '../src/host/modules/delegate/service.ts'
import { clampText } from '../src/lib/caps.ts'

/** neutralize as of a260fc1. */
function legacyNeutralize(input: string): string {
  if (typeof input !== 'string' || input === '') return ''
  if (!input.includes('{{') && !input.includes('}}')) return input
  let output = ''
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string
    output += char
    const next = input[index + 1]
    if ((char === '{' || char === '}') && next === char) output += ' '
  }
  return output
}

/** summarize as of a260fc1. */
function legacySummarize(output: string, error?: string): string {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  const first = lines.find(line => !line.startsWith('[…')) ?? lines[0]
  return clampText(legacyNeutralize(first ?? error ?? '(no output)'), 240)
}

describe('M5 neutralize equivalence (pre-patch oracle)', () => {
  it('documented cases', () => {
    const cases = [
      '',
      'no braces at all',
      'single { and } stay',
      '{{value}}',
      'a {{ b }} c',
      '{{{triple}}}',
      '}}{{',
      '}}{{{{',
      '{ { } }',
      'a}b}c',
      '}}}' + 'x'.repeat(5000),
      '{{',
      '}}',
      '}',
      '{',
      'x{{y',
      '{{}}',
      '{}{}{}{}',
      'mixed 中文 {{ ok }} 😀 text',
      'brace at the very end {{',
      'brace at the very start {{',
    ]
    for (const value of cases) expect(neutralize(value), JSON.stringify(value.slice(0, 30))).toBe(legacyNeutralize(value))
  })

  it('1 MiB bodies: no braces / one pair / many pairs / boundary at the pair', () => {
    const filler = 'build output line with words and a number 42\n'.repeat(30_000)
    const oneMiB = filler.slice(0, 1024 * 1024)
    expect(Buffer.byteLength(oneMiB)).toBeGreaterThanOrEqual(1024 * 1024)

    const shapes: Array<{ name: string; value: string }> = [
      { name: 'no braces', value: oneMiB },
      { name: 'one pair at the start', value: `{{${oneMiB}` },
      { name: 'one pair at the end', value: `${oneMiB}}` },
      { name: 'one pair in the middle', value: `${oneMiB.slice(0, 500_000)}{{${oneMiB.slice(500_000)}` },
      { name: 'many pairs', value: oneMiB.replace(/\n/g, '\n{{x}}\n') },
      { name: 'straddling the 8192 boundary', value: `${'a'.repeat(8191)}{{${'b'.repeat(20_000)}` },
    ]
    for (const { name, value } of shapes) {
      const now = neutralize(value)
      const before = legacyNeutralize(value)
      expect(now.length, `${name}: length`).toBe(before.length)
      expect(now, `${name}: bytes`).toBe(before)
    }
  })

  it('idempotence and the no-pair-remaining property still hold', () => {
    for (const value of ['{{a}}', '{{{b}}}', 'x{{y}}z', `{{${'q'.repeat(20_000)}`]) {
      const once = neutralize(value)
      expect(neutralize(once)).toBe(once)
      expect(once).not.toContain('{{')
      expect(once).not.toContain('}}')
    }
  })

  it('returns the SAME string instance when there is nothing to change', () => {
    const clean = 'no braces here at all'
    expect(neutralize(clean)).toBe(clean)
    // Braces present but no adjacent pair: still unchanged, no copy.
    const lone = 'a { b } c'
    expect(neutralize(lone)).toBe(legacyNeutralize(lone))
  })

  it('randomized: 500 brace-heavy strings match the oracle', () => {
    let seed = 0xbace
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const pieces = ['{', '}', '{{', '}}', '{{{', '}}}', 'a', ' ', '\n', '中', '😀', '}}}}{{']
    for (let round = 0; round < 500; round += 1) {
      let value = ''
      const length = 1 + Math.floor(rand() * 30)
      for (let i = 0; i < length; i += 1) value += pieces[Math.floor(rand() * pieces.length)] ?? 'x'
      expect(neutralize(value), `round ${round} ${JSON.stringify(value)}`).toBe(legacyNeutralize(value))
    }
  })
})

describe('M5 summarize equivalence (pre-patch oracle)', () => {
  it('shapes: empty, blank, markers, error fallback, long line', () => {
    const cases: Array<{ value: string; error?: string }> = [
      { value: '' },
      { value: '', error: 'exit code 1' },
      { value: '\n\n\n' },
      { value: '\n\n\n', error: 'boom' },
      { value: '   \n\t\n' },
      { value: 'first line\nsecond line' },
      { value: '  padded  \n  second  ' },
      { value: '[… head dropped — output exceeded the per-stream cap …]\nreal first line' },
      { value: '[… head dropped…]\n[… more…]\nonly markers' },
      { value: 'single line without newline' },
      { value: 'x'.repeat(5000) },
      { value: '中文'.repeat(2000) },
      { value: '😀'.repeat(2000) },
      { value: `{{braces}} in the first line\nmore` },
    ]
    for (const { value, error } of cases) {
      expect(summarize(value, error), `len ${value.length}`).toBe(legacySummarize(value, error))
    }
  })

  it('blank lines past the 8192-char bound: the real first line is still found', () => {
    // The head holds no COMPLETE non-empty line, so the bounded path must fall
    // through to the full rule — which finds the line beyond the bound.
    const value = `${'\n'.repeat(9000)}real first line\nlater`
    expect(summarize(value)).toBe(legacySummarize(value))
    expect(summarize(value)).toContain('real first line')
  })

  it('a first line RUNNING PAST the bound (partial segment) picks the legacy line', () => {
    // The first line starts at 0 and is still incomplete at the cut; the fast
    // path drops the partial tail and the full rule answers — same as before.
    const value = `${'x'.repeat(9000)}\nreal first line\nlater`
    expect(summarize(value)).toBe(legacySummarize(value))
    expect(summarize(value)).toContain('x')
  })

  it('a first line that spans the bound (partial segment) still matches', () => {
    const value = `${'y'.repeat(8000)}${'z'.repeat(2000)}\nsecond`
    expect(summarize(value)).toBe(legacySummarize(value))
  })

  it('a 1 MiB body: the bounded path answers the same as the full scan', () => {
    const filler = 'line: build ok in 1.2s\n'.repeat(50_000)
    const oneMiB = filler.slice(0, 1024 * 1024)
    expect(summarize(oneMiB)).toBe(legacySummarize(oneMiB))
    // Same for a 1 MiB body whose head is nothing but cap markers.
    const markers = '[… head dropped — output exceeded the per-stream cap …]\n'.repeat(40_000).slice(0, 1024 * 1024)
    expect(summarize(markers)).toBe(legacySummarize(markers))
  })

  it('randomized: 400 bodies match the oracle', () => {
    let seed = 0xfeed
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const lines = ['', ' ', '  ', 'real output', '[… head dropped — x]', '[… more]', 'a {{ b }}', '😀 unicode', 'x'.repeat(300)]
    for (let round = 0; round < 400; round += 1) {
      const count = Math.floor(rand() * 25)
      const parts: string[] = []
      for (let i = 0; i < count; i += 1) parts.push(lines[Math.floor(rand() * lines.length)] ?? 'x')
      const value = parts.join('\n')
      const error = rand() < 0.3 ? `err ${round}` : undefined
      expect(summarize(value, error), `round ${round} lines ${count}`).toBe(legacySummarize(value, error))
    }
  })
})
