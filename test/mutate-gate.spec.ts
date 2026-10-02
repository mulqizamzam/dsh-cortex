/**
 * I-02 mutation gate tests.
 *
 * `gateMutation` gates any destructive operation behind a two-step confirm
 * when `confirmRequired` is true. When false, the call goes straight through.
 * Pure unit tests — the token store is in-module, so the same fixture is used
 * across all calls in a test to prove single-use semantics.
 */
import { describe, expect, it } from 'vitest'
import { gateMutation } from '../src/host/modules/mutate-gate.ts'

describe('mutation gate (I-02)', () => {
  it('confirmRequired=false: executes the operation directly', async () => {
    let ran = false
    const result = await gateMutation(false, 'test:direct', undefined, 'test', async () => {
      ran = true
      return { done: true }
    })
    expect(result.ok).toBe(true)
    expect(ran).toBe(true)
    expect(result.result).toEqual({ done: true })
    expect(result.token).toBeUndefined()
  })

  it('confirmRequired=true, no confirm: returns a token, does not execute', async () => {
    let ran = false
    const step1 = await gateMutation(true, 'test:gate1', undefined, 'test op', async () => {
      ran = true
      return { done: true }
    })
    expect(step1.ok).toBe(true)
    expect(step1.token).toBeTruthy()
    expect(ran).toBe(false)
  })

  it('confirmRequired=true, correct token: executes', async () => {
    let executed = 0
    const step1 = await gateMutation(true, 'test:gate2', undefined, 'test op', async () => {
      executed += 1
      return { n: executed }
    })
    const token = step1.token!
    const step2 = await gateMutation(true, 'test:gate2', token, 'test op', async () => {
      executed += 1
      return { n: executed }
    })
    expect(step2.ok).toBe(true)
    expect(step2.result).toEqual({ n: 1 })
    expect(executed).toBe(1)
  })

  it('confirmRequired=true, wrong token: refuses and does not execute', async () => {
    let executed = 0
    await gateMutation(true, 'test:gate3', undefined, 'test op', async () => {
      executed += 1
    })
    const wrong = await gateMutation(true, 'test:gate3', 'not-the-real-token', 'test op', async () => {
      executed += 1
    })
    expect(wrong.ok).toBe(false)
    expect(wrong.warning).toContain('not the single-use token')
    expect(executed).toBe(0)
  })

  it('confirmRequired=true, token reuse: second use is refused', async () => {
    let executed = 0
    const step1 = await gateMutation(true, 'test:reuse', undefined, 'test', async () => {
      executed += 1
      return { n: executed }
    })
    const token = step1.token!
    await gateMutation(true, 'test:reuse', token, 'test', async () => {
      executed += 1
    })
    const reuse = await gateMutation(true, 'test:reuse', token, 'test', async () => {
      executed += 1
    })
    expect(reuse.ok).toBe(false)
    expect(executed).toBe(1) // only the first use ran
  })
})
