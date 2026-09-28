import { describe, expect, it } from 'vitest'
import { neutralize } from '../../src/lib/sanitize.ts'
import { renderHits, scoreEntry, searchEntries, snippet, tokenize } from '../../src/host/modules/memory/search.ts'
import type { Entry } from '../../src/host/types.ts'

/** Unit tests for the local scorer: no index, no dependencies, no surprises. */

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'a'.repeat(12), track: 'global', content: '', importance: 3, tags: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', origin: 'user', ...over,
  }
}

describe('tokenize + score', () => {
  it('splits on punctuation and drops noise', () => {
    expect(tokenize('  Deploy-Gate, and CI!! ')).toEqual(['deploy-gate', 'and', 'ci'])
    expect(tokenize('a bb cccc')).toEqual(['bb', 'cccc'])
  })

  it('ranks a phrase hit above a token hit, and an active entry above an archived one', () => {
    const phrase = entry({ id: 'p'.repeat(12), content: 'the deploy gate is behind a flag' })
    const tokens = entry({ id: 't'.repeat(12), content: 'a gate somewhere, deploy later' })
    const archived = entry({ id: 'a'.repeat(12), content: 'the deploy gate is behind a flag', archivedAt: '2026-02-01T00:00:00.000Z' })
    const query = 'deploy gate'
    const parts = tokenize(query)
    expect(scoreEntry(phrase, query, parts)).toBeGreaterThan(scoreEntry(tokens, query, parts))
    expect(scoreEntry(archived, query, parts)).toBeLessThan(scoreEntry(phrase, query, parts))
    expect(scoreEntry(entry({ content: 'unrelated' }), query, parts)).toBe(0)
  })

  it('matches tags and branch scopes as weaker signals', () => {
    const tagged = entry({ content: 'nothing relevant here at all', tags: ['deploy-gate'] })
    const scoped = entry({ content: 'nothing relevant here at all', branches: ['deploy-gate'] })
    expect(scoreEntry(tagged, 'deploy-gate', ['deploy-gate'])).toBeGreaterThan(0)
    expect(scoreEntry(scoped, 'deploy-gate', ['deploy-gate'])).toBeGreaterThan(0)
  })
})

describe('snippet + result cap', () => {
  it('windows around the match and marks both ends', () => {
    const long = `${'padding '.repeat(40)}needle in the middle${' tail'.repeat(60)}`
    const text = snippet(long, 'needle', ['needle'])
    expect(text.length).toBeLessThanOrEqual(160 * 2 + 2)
    expect(text).toContain('needle in the middle')
    expect(text.startsWith('…')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })

  it('a snippet can never carry a brace pair', () => {
    const text = snippet('the template is {{session}} here', 'template', ['template'])
    expect(text).not.toContain('{{')
    expect(text).not.toContain('}}')
    expect(text).toContain('{ {session} }')
  })

  it('search drops non-matches and respects the limit', () => {
    const entries = [
      entry({ id: 'f'.repeat(12), content: 'first thing about releases' }),
      entry({ id: 's'.repeat(12), content: 'unrelated notes' }),
      entry({ id: 't'.repeat(12), content: 'second release note' }),
    ]
    const found = searchEntries({ entries, query: 'release' })
    expect(found.candidates).toBe(2)
    // Equal scores and stamps fall through to the deterministic id tiebreak.
    expect(found.hits.map(hit => hit.id)).toEqual(['f'.repeat(12), 't'.repeat(12)])
    const capped = searchEntries({ entries, query: 'release', limit: 1 })
    expect(capped.hits).toHaveLength(1)
    expect(capped.candidates).toBe(2)
  })

  it('renderHits never exceeds the character budget and says what it dropped', () => {
    const hits = Array.from({ length: 20 }, (_unused, index) => ({
      id: `id${index}`, track: 'global' as const, snippet: `snippet ${index} ${'x'.repeat(60)}`, score: 30 - index, branches: [], archived: false,
    }))
    const roomy = renderHits(hits, { maxChars: 8000, candidates: 20 })
    expect(roomy.shown).toBe(20)
    expect(roomy.omitted).toBe(0)
    const tight = renderHits(hits, { maxChars: 500, candidates: 20 })
    expect(tight.text.length).toBeLessThanOrEqual(500)
    expect(tight.shown).toBeLessThan(20)
    expect(tight.omitted).toBe(20 - tight.shown)
    expect(tight.text).toContain('more match(es) omitted')
    const hopeless = renderHits(hits, { maxChars: 12, candidates: 20 })
    expect(hopeless.text.length).toBeLessThanOrEqual(12)
    expect(hopeless.shown).toBe(0)
    const none = renderHits([], { maxChars: 500, candidates: 0 })
    expect(none.text).toContain('No memory entries matched')
  })

  it('the listing cap note survives capping and is honest', () => {
    const hits = [{ id: 'z', track: 'user' as const, snippet: 'x', score: 5, branches: ['feat/{{a}}'], archived: true }]
    const rendered = renderHits(hits, { maxChars: 4000, candidates: 1, listingTruncated: true })
    expect(rendered.text).toContain('500-entry read cap')
    expect(rendered.text).not.toContain('{{')
    expect(rendered.text).toContain('archived')
    expect(neutralize(rendered.text)).toBe(rendered.text)
  })
})
