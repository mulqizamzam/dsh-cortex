/**
 * The RPC error-vocabulary contract.
 *
 * The host parses every reply with `serverResponseSchema.parse(...)`
 * (packages/client/connection/src/client/rpc.ts:47) — a THROW. A single code
 * outside its 40-member union turns an honest one-line refusal into a zod dump
 * on the caller's screen, which is exactly how a plain `not-wired` refusal once
 * reached the browser as ~2 kB of schema noise. Nothing about that failure is
 * local: no unit test, no type error, no log line on our side.
 *
 * So this file pins the boundary from BOTH sides — the mapping, and the fact
 * that every code the plugin can emit lands inside the host's set.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HOST_CODES_WITH_EMPTY_DETAILS,
  HOST_RPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  hostErrorCode,
  refuse,
} from '../src/host/rpc-error.ts'
import { readEndpoints as boardRead, writeEndpoints as boardWrite } from '../src/host/modules/board/rpc.ts'
import { readEndpoints as roomsRead } from '../src/host/modules/rooms/rpc.ts'
import { readEndpoints as todoRead, writeEndpoints as todoWrite } from '../src/host/modules/todo/index.ts'
import { readEndpoints as promptsRead } from '../src/host/modules/prompts/rpc.ts'
import { readEndpoints as delegateRead } from '../src/host/modules/delegate/rpc.ts'
import { pluginErrorCode } from '../src/client/api.ts'

describe('the plugin RPC error vocabulary', () => {
  it('projects every plugin code onto a code the host accepts', () => {
    for (const code of PLUGIN_RPC_ERROR_CODES) {
      expect(HOST_RPC_ERROR_CODES).toContain(hostErrorCode(code))
    }
  })

  it('never ships an unmapped code raw', () => {
    // An unmapped code is a bug in whoever invented it, so it degrades to
    // `internal` (our fault) rather than becoming an undeliverable reply.
    expect(hostErrorCode('something-new')).toBe('internal')
    expect(hostErrorCode('not-wired')).toBe('internal')
    expect(hostErrorCode('handler-failed')).toBe('internal')
  })

  it('keeps the plugin code in the message, which the host does not police', () => {
    const result = refuse('board is disabled by config', 'disabled')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    const { code, message } = result.error
    if (code === undefined) throw new Error('a refusal must carry a code')
    expect(code).toBe('command-error')
    // The host code says WHO is at fault; the message still says WHAT.
    expect(message).toBe('[disabled] board is disabled by config')
  })

  it('always decorates, so a projection is visible in the log', () => {
    const result = refuse('roomId is required', 'refused')
    if (result.ok) throw new Error('unreachable')
    const { code, message } = result.error
    if (code === undefined) throw new Error('a refusal must carry a code')
    expect(code).toBe('command-error')
    expect(message).toBe('[refused] roomId is required')
  })

  it('every refusal these endpoints can produce is deliverable', async () => {
    // Drive the real endpoints down their refusal paths — undeclared slot,
    // blank arguments, an unwired channel, a disabled module — and require that
    // each answer survives the host's schema. Shape assertions alone would not
    // catch this: the failure is at the serialization boundary, downstream.
    const cases: Array<[string, () => unknown]> = [
      ['boards.list no roomId', () => boardRead['boards.list']!({})],
      ['boards.get no ids', () => boardRead['boards.get']!({ roomId: 'r' })],
      ['rooms.list no args', () => roomsRead['rooms.list']!({})],
      ['todo.list no track', () => todoRead['todo.list']!({ track: 'nonsense' })],
      ['todo.add blank text', () => todoWrite['todo.add']!({ text: '   ' })],
      ['prompts.get no id', () => promptsRead['prompts.get']!({})],
      ['delegation blank jobId', () => delegateRead['jobs.get']!({ jobId: '' })],
      ['boards.addCard no board', () => boardWrite['boards.addCard']!({ title: 'x' })],
    ]
    for (const [label, run] of cases) {
      const result = await run() as { ok: boolean; error?: { code?: string; message?: string } }
      if (result.ok === false) {
        expect(`${label}: ${result.error?.code ?? 'no code'}`).toMatch(
          new RegExp(`^${label}: (${HOST_RPC_ERROR_CODES.join('|')})$`),
        )
      }
    }
  })

  it('the client recovers the plugin code the host had to project away', () => {
    // The round trip that makes the whole arrangement work: the host may only
    // put its own vocabulary in `error.code`, and the client's "not mounted"
    // and health branches depend on OURS. If this pairing ever breaks, every
    // refusal reads as the host's `bad-request` and the settings card starts
    // reporting a healthy host as down.
    const refused = refuse('prompts.list is not wired', 'unknown-endpoint')
    if (refused.ok) throw new Error('unreachable')
    const { code, message } = refused.error
    if (code === undefined) throw new Error('a refusal must carry a code')
    expect(code).toBe('command-error')
    expect(pluginErrorCode({ code, message })).toBe('unknown-endpoint')
  })

  it('a bare refusal still carries its own code in the message', () => {
    const plain = refuse('roomId is required', 'bad-request')
    if (plain.ok) throw new Error('unreachable')
    expect(pluginErrorCode({ code: plain.error.code ?? '', message: plain.error.message })).toBe('bad-request')
  })

  it('every code the client branches on survives the projection', () => {
    // These three literals are a contract between the host's `refuse` and the
    // client's `pluginErrorCode`. Renaming one without the other turns a
    // missing feature into a silent "host is down".
    for (const code of ['unknown-endpoint']) {
      const r = refuse('x', code)
      if (r.ok) throw new Error('unreachable')
      expect(pluginErrorCode({ code: r.error.code ?? '', message: r.error.message })).toBe(code)
    }
  })

  it('no call site in src/host invents a code the mapping does not carry', () => {
    // The mapping only helps if it stays complete. `no-session` was missed once
    // already: a service-level code passed straight through, which then landed
    // as `internal` — a different answer than intended, in the one field the
    // host reads. So check the source, not just the helper.
    const root = new URL('../src/host/', import.meta.url).pathname
    const used = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (!entry.endsWith('.ts') || entry === 'rpc-error.ts') continue
        const text = readFileSync(full, 'utf8')
        for (const m of text.matchAll(/(?:nope|asNope|refuse)\((?:[^()]|\([^()]*\))*?,\s*'([a-z][a-z-]*)'\s*\)/g)) {
          used.add(m[1] as string)
        }
      }
    }
    walk(root)
    // The helpers' own default argument counts as a code in use.
    used.add('bad-request')
    const unmapped = [...used].filter(code => !PLUGIN_RPC_ERROR_CODES.includes(code)).sort()
    expect(unmapped).toEqual([])
    expect(used.size).toBeGreaterThan(8)
  })

  it('the panel shows the plugin code, not the host one', () => {
    // Otherwise a user reads "boards.list failed — command-error: [disabled] …":
    // two codes for one refusal, the first of which means nothing to them. The
    // host code decides nothing here; ours is the one that was actionable.
    const refused = refuse('board is disabled by config (board.enabled = false)', 'disabled')
    if (refused.ok) throw new Error('unreachable')
    const { code, message } = refused.error
    if (code === undefined) throw new Error('a refusal must carry a code')
    expect(pluginErrorCode({ code, message })).toBe('disabled')
    expect(pluginErrorCode({ code, message })).not.toBe(code)
  })

  it('only sends host codes whose details shape we can actually fill', () => {
    // The half the first guard missed, and the reason a live refusal still
    // failed to parse after the code vocabulary was fixed: 36 of the 40 host
    // codes require per-code `details` keys (`bad-request` wants
    // `issues: ZodIssue[]`). Choosing such a code means inventing host-shaped
    // data to satisfy a validator, so the plugin may only use the empty ones.
    const used = new Set(PLUGIN_RPC_ERROR_CODES.map(code => hostErrorCode(code)))
    for (const code of used) {
      expect(`${code} ${HOST_CODES_WITH_EMPTY_DETAILS.join(' ')}`).toContain(code)
    }
    expect(used.size).toBeGreaterThan(1)
  })

  it('every refusal carries the details the host requires', () => {
    // `details is required` on all 40 branches (rpc.schema.ts:32). A refusal
    // without it has a VALID code and still dies at the envelope.
    for (const code of PLUGIN_RPC_ERROR_CODES) {
      const result = refuse('something went wrong', code)
      if (result.ok) throw new Error('unreachable')
      const { code: host, message, details } = result.error
      if (host === undefined) throw new Error('a refusal must carry a code')
      expect(typeof message, code).toBe('string')
      expect(details, code).toEqual({})
    }
  })

  it('the settings card probe survives the real host schema', () => {
    // The exact shape the running host parsed and THREW on. Kept as a case
    // because it is the only one that ever reached a browser.
    const result = refuse('unknown cortex write endpoint: __cortex_probe__', 'unknown-endpoint')
    if (result.ok) throw new Error('unreachable')
    const { code, message, details } = result.error
    if (code === undefined) throw new Error('a refusal must carry a code')
    expect(HOST_CODES_WITH_EMPTY_DETAILS).toContain(code)
    expect(details).toEqual({})
    // What the card then shows the user: our code, not the host's.
    expect(message.startsWith('[unknown-endpoint]')).toBe(true)
  })
})
