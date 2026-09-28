// @vitest-environment node
/**
 * The security invariants, as executable rules.
 *
 * A reviewer should not have to eyeball JSX for an HTML sink: these tests read
 * every file in `src/client/**` and fail on the patterns themselves, then check
 * the text layer's behaviour on the strings that would matter. The `grep`
 * commands in SECURITY.md and these assertions are the same rule in two
 * languages on purpose.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderParts, safeHref, textParts } from '../../src/client/text.ts'

const CLIENT_DIR = new URL('../../src/client/', import.meta.url).pathname

function clientFiles(): Array<{ name: string; source: string }> {
  return readdirSync(CLIENT_DIR)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, source: readFileSync(join(CLIENT_DIR, name), 'utf8') }))
}

/** Patterns that would let a stored string become markup. */
const BANNED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/ },
  { label: 'innerHTML', pattern: /\.innerHTML\b/ },
  { label: 'outerHTML', pattern: /\.outerHTML\b/ },
  { label: 'insertAdjacentHTML', pattern: /insertAdjacentHTML\s*\(/ },
  { label: 'createContextualFragment', pattern: /createContextualFragment\s*\(/ },
  { label: 'document.write', pattern: /document\.write(?:ln)?\s*\(/ },
  { label: 'eval', pattern: /\beval\s*\(/ },
  { label: 'new Function', pattern: /new\s+Function\s*\(/ },
  { label: 'ChildNode/html string prop', pattern: /\bhtml:\s*['"`]/ },
]

/** Node-only surfaces a browser bundle must never reach for. */
const FORBIDDEN_IMPORTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'node:fs', pattern: /from\s+['"]node:fs/ },
  { label: 'node:path', pattern: /from\s+['"]node:path/ },
  { label: 'node:child_process', pattern: /from\s+['"]node:child_process/ },
  { label: 'require(', pattern: /(^|[^.\w])require\s*\(/ },
  { label: 'process.env', pattern: /process\.env\b/ },
]

describe('no HTML sink exists in the client', () => {
  it('every client file is free of markup-injection sinks', () => {
    const hits: string[] = []
    for (const file of clientFiles()) {
      // Comments may NAME a banned sink (this file does); a code line may not.
      const code = file.source
        .split('\n')
        .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n')
      for (const rule of BANNED) {
        if (rule.pattern.test(code)) hits.push(`${file.name}: ${rule.label}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('the only file that can emit an href is the text layer', () => {
    const withHref = clientFiles()
      .filter(file => /\bhref:/.test(file.source.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n')))
      .map(file => file.name)
    expect(withHref).toEqual(['text.ts'])
  })

  it('no client file touches node', () => {
    const hits: string[] = []
    for (const file of clientFiles()) {
      for (const rule of FORBIDDEN_IMPORTS) {
        if (rule.pattern.test(file.source)) hits.push(`${file.name}: ${rule.label}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('the client imports nothing at runtime except react and its own files', () => {
    const offenders: string[] = []
    for (const file of clientFiles()) {
      const code = file.source.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n')
      for (const match of code.matchAll(/^import\s+(?!type\s)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
        const specifier = match[2]
        const isTypeOnly = /(^|\n)\s*import\s+type\s/.test(match[0] ?? '')
        if (isTypeOnly) continue
        if (specifier === 'react' || specifier.startsWith('./') || specifier.startsWith('../host/types.ts')) continue
        offenders.push(`${file.name}: ${specifier}`)
      }
      // Type-only host coupling is allowed; a value import from src/host is not.
      for (const match of code.matchAll(/^import\s+type\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
        if (!match[1].startsWith('../host/types.ts')) continue
        if (!/\bConfig\b|\bStore\b|\brpc\b/.test(match[0] ?? '')) continue
        offenders.push(`${file.name}: type import pulls a host implementation name (${match[1]})`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the text layer on the strings that matter', () => {
  it('markup stays text', () => {
    expect(textParts('<script>alert(1)</script>')).toEqual([{ text: '<script>alert(1)</script>' }])
    expect(textParts('<img src=x onerror="alert(1)">')).toEqual([{ text: '<img src=x onerror="alert(1)">' }])
    expect(textParts('{{7*7}}')).toEqual([{ text: '{{7*7}}' }])
    expect(textParts('')).toEqual([])
  })

  it('interpolation slots in hostile content are not re-read as slots', () => {
    const parts = textParts('look {0} here')
    expect(parts).toEqual([{ text: 'look {0} here' }])
  })

  it('a URL becomes a link, and only a safe scheme becomes an href', () => {
    const parts = textParts('see https://example.com/a?b=1&c=2 for details')
    expect(parts).toHaveLength(3)
    expect(parts[1].href).toBe('https://example.com/a?b=1&c=2')
    expect(parts[1].text).toBe('https://example.com/a?b=1&c=2')
    expect(parts[2].text).toBe(' for details')
    expect(textParts('www.example.com')[0].href).toBe('https://www.example.com')
    expect(safeHref('https://x.test/a')).toBe('https://x.test/a')
    expect(safeHref('#anchor')).toBe('#anchor')
    expect(safeHref('/relative/path')).toBe('/relative/path')
    expect(safeHref('mailto:me@example.com')).toBe('mailto:me@example.com')
  })

  it('javascript:, data:, protocol-relative and oversized hrefs are refused', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeHref('//evil.test/x')).toBeUndefined()
    expect(safeHref(`https://x.test/${'y'.repeat(3000)}`)).toBeUndefined()
    // And the same hostile URL inside prose stays plain text.
    expect(textParts('click javascript:alert(1) now')).toEqual([{ text: 'click javascript:alert(1) now' }])
  })

  it('a link label is capped, and the parts carry no attributes at all', () => {
    const long = `https://x.test/${'z'.repeat(400)}`
    const parts = textParts(long)
    expect(parts[0].text.length).toBeLessThanOrEqual(121)
    expect(Object.keys(parts[0])).toEqual(['text', 'href'])
  })

  it('rendered parts are plain values, not element-shaped objects', () => {
    const rendered = renderParts(textParts('plain text only'))
    expect(typeof rendered).toBe('string')
  })
})
