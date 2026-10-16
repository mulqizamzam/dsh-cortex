/**
 * `stateRoot` is the ONE directory this plugin writes (P5/P6), and the README
 * sells the uninstall contract on it: delete `<DSH_HOME>/dsh-cortex` and every
 * byte is gone.
 *
 * `resolveConfig` accepted ANY string and `boot` used it verbatim, so a natural
 * `stateRoot: "~/dsh-cortex"` became a relative path resolved against whatever
 * cwd the host happened to have — creating a literal `~` directory beside the
 * user's repo and orphaning all plugin state from that contract. A bare
 * `some/dir` did the same, silently.
 *
 * The runner-cwd rule two functions up already had the right discipline ("only
 * an absolute path is honoured"). This is the same rule, for the path that
 * matters more, plus a warning so the ignored override is never silent.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/host/config.ts'

describe('stateRoot accepts only an absolute override', () => {
  it('keeps an absolute path', () => {
    expect(resolveConfig({ stateRoot: '/srv/cortex-state' }).stateRoot).toBe('/srv/cortex-state')
  })

  it('falls back to the default for a ~/ path instead of creating a literal ~ directory', () => {
    const warnings: string[] = []
    const resolved = resolveConfig({ stateRoot: '~/dsh-cortex' }, message => warnings.push(message))
    expect(resolved.stateRoot).toBe('')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('~/dsh-cortex')
    expect(warnings[0]).toContain('not an absolute path')
  })

  it('falls back to the default for a plain relative path', () => {
    const warnings: string[] = []
    expect(resolveConfig({ stateRoot: 'relative/state' }, message => warnings.push(message)).stateRoot).toBe('')
    expect(warnings).toHaveLength(1)
  })

  it('stays silent for the documented default and for a valid override', () => {
    const warnings: string[] = []
    expect(resolveConfig({}, message => warnings.push(message)).stateRoot).toBe('')
    expect(resolveConfig({ stateRoot: '/abs/ok' }, message => warnings.push(message)).stateRoot).toBe('/abs/ok')
    expect(warnings).toEqual([])
  })
})
