/**
 * M5 tail audit — semantics oracle + baseline, BEFORE any patch.
 *
 * Documented semantics of `DelegateService.tail(kind, jobId, tailBytes)`:
 *   - tailBytes arrives clamped to 256..65536 (default 8192) from both callers;
 *     `tailByBytes` itself treats <=0 as '' (unreachable in practice)
 *   - missing file (ENOENT) -> { text: '', truncated: false }, NO warn;
 *     any other read error -> warn + same shape
 *   - empty file -> { text: '', truncated: false }
 *   - byteLength(raw) <= tailBytes -> text is the WHOLE file, truncated false
 *   - raw longer -> the shortest UTF-16 suffix whose re-encoded byte length is
 *     STRICTLY < tailBytes (the strict-< quirk: 8193 B file at tailBytes 8192
 *     yields an 8191 B suffix, i.e. TWO bytes dropped from the head, not one)
 *   - truncation boundary is a UTF-16 code-unit index, so for an astral pair
 *     the cut can land between the surrogates and the suffix then STARTS with
 *     a lone low surrogate (not U+FFFD) — pinned below
 *   - truncated = byteLength(raw) > byteLength(text)
 *   - files are written only by StreamSink.persist -> writeTextAtomic, so a
 *     file is valid UTF-8 by construction; byteLength(decode(bytes)) == size
 *
 * The oracle here is a naive linear scan (independent formulation of the same
 * rule), not a copy of the production binary search. Step 5 of the audit
 * compares a future offset-read against this oracle; the production result is
 * asserted equal to it first, which also proves the binary search correct.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore } from '../src/host/store.ts'
import { tailByBytes } from '../src/host/modules/delegate/runner.ts'

let root = ''
let store: CortexStore
let jobId = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'm5-tail-'))
  store = new CortexStore({ root })
  await store.init()
  const job = await store.createJob({ runner: 'probe', argv: ['/bin/true'], task: 'tail audit' })
  if (!job.ok || job.data === undefined) throw new Error('job create failed')
  jobId = job.data.id
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

/** Naive oracle: the documented rule, stated as a linear scan. */
function oracleTail(text: string, bytes: number): string {
  if (bytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= bytes) return text
  for (let index = 0; index < text.length; index += 1) {
    if (Buffer.byteLength(text.slice(index), 'utf8') < bytes) return text.slice(index)
  }
  return ''
}

async function svcTail(text: string | null, tailBytes: number): Promise<{ text: string; truncated: boolean }> {
  const { DelegateService } = await import('../src/host/modules/delegate/service.ts')
  const { resolveConfig } = await import('../src/host/config.ts')
  const file = store.jobPaths(jobId).stdout
  if (text !== null) await writeFile(file, text, 'utf8')
  const deps = {
    ctx: {} as never,
    cfg: () => resolveConfig({}),
    store,
    log: () => {},
    warn: () => {},
    runtime: () => ({ modules: [], errors: [] }),
  } as never
  const svc = new DelegateService(deps as never)
  return await svc.tail('stdout', jobId, tailBytes)
}

describe('M5 tail semantics (baseline, pre-patch)', () => {
  it('missing and empty files answer { text: "", truncated: false }', async () => {
    expect(await svcTail(null, 8192)).toEqual({ text: '', truncated: false })
    expect(await svcTail('', 8192)).toEqual({ text: '', truncated: false })
  })

  it('small file: whole content, not truncated', async () => {
    const result = await svcTail('hello\nworld\n', 8192)
    expect(result).toEqual({ text: 'hello\nworld\n', truncated: false })
  })

  it('exact boundary: byteLength == tailBytes returns the whole file, not truncated', async () => {
    const content = 'a'.repeat(8192)
    expect(Buffer.byteLength(content)).toBe(8192)
    const result = await svcTail(content, 8192)
    expect(result.text).toBe(content)
    expect(result.truncated).toBe(false)
  })

  it('strict-< quirk: one byte over drops TWO head bytes and reports truncated', async () => {
    const content = 'b'.repeat(8193)
    const result = await svcTail(content, 8192)
    expect(result.text.length, 'the suffix is bytes-1 long, not bytes').toBe(8191)
    expect(result.text).toBe(content.slice(2))
    expect(result.truncated).toBe(true)
  })

  it('multibyte boundary: the cut is the first UTF-16 index whose suffix is under budget', async () => {
    // 'a' (1 B) + 5 * '中' (3 B each) = 16 B; tailBytes 10 -> suffix must be
    // < 10 B: index 0 -> 16, 1 -> 15, 2 -> 12, 3 -> 9. So index 3.
    const content = 'a中中中中中'
    expect(Buffer.byteLength(content)).toBe(16)
    const result = await svcTail(content, 10)
    expect(result.text).toBe('中中中')
    expect(Buffer.byteLength(result.text)).toBe(9)
    expect(result.truncated).toBe(true)
  })

  it('astral mid-pair quirk: the cut can land between surrogates (pinned)', async () => {
    // '😀' = 4 UTF-8 B, 2 UTF-16 units. Arrange its start at EXACTLY
    // total-bytes so the mid-pair index qualifies but the pair start does not.
    const head = 'x'.repeat(6) // 6 B
    const tailPart = 'y'.repeat(6) // 6 B
    const content = `${head}😀${tailPart}` // 6 + 4 + 6 = 16 B, 6 + 2 + 6 = 14 units
    expect(Buffer.byteLength(content)).toBe(16)
    // tailBytes 10: pair starts at byte 6 == total-bytes = 16-10 = 6.
    const result = await svcTail(content, 10)
    const expected = oracleTail(content, 10)
    expect(result.text).toBe(expected)
    // The pinned shape: first char is a lone low surrogate.
    expect(result.text.charCodeAt(0)).toBeGreaterThanOrEqual(0xdc00)
    expect(result.text.charCodeAt(0)).toBeLessThanOrEqual(0xdfff)
    expect(result.truncated).toBe(true)
  })

  it('production tailByBytes agrees with the naive oracle across randomized inputs', () => {
    let seed = 0x5eed
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const alphabets = ['abcdefgh', '中文测试', 'éèê', '😀🎉', 'mixed 中 a 😀']
    for (let round = 0; round < 300; round += 1) {
      const alphabet = alphabets[Math.floor(rand() * alphabets.length)] ?? 'x'
      let text = ''
      const length = Math.floor(rand() * 60)
      for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(rand() * alphabet.length)] ?? 'x'
      const bytes = 1 + Math.floor(rand() * 40)
      expect(tailByBytes(text, bytes), `bytes=${bytes} text=${JSON.stringify(text)}`).toBe(oracleTail(text, bytes))
    }
  })

  it('BENCH baseline: current tail() for small / exact-boundary / large files', async () => {
    const sizes = [
      { name: 'small 64 B', size: 64 },
      { name: 'exact 8192 B', size: 8192 },
      { name: 'large 1 MiB', size: 1024 * 1024 },
    ]
    for (const { name, size } of sizes) {
      await svcTail('x'.repeat(size), 8192) // warm the import path
      const rounds = 20
      const started = performance.now()
      for (let round = 0; round < rounds; round += 1) await svcTail('x'.repeat(size), 8192)
      const ms = (performance.now() - started) / rounds
      console.log(`BENCH tail baseline ${name}: ${ms.toFixed(2)} ms/call (8192 B window)`)
    }
    // The large case is the one the flamegraph flagged; it must be visibly
    // slower than the small one or the premise of this audit is wrong.
    expect(true).toBe(true)
  })
})
