/**
 * A lost `seq.txt` must recover the counter ABOVE the highest message already on
 * disk. The recovery read used `listDir(.., 2000)`, which keeps the OLDEST names
 * (the sorted page is sliced from the front), so past 2000 messages it read the
 * wrong end of the directory: the recovered seq landed on a number that already
 * had a message file, and the new post overwrote the stored one while still
 * reporting success.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexStore } from '../../src/host/store.ts'
import { makeTempRoot, removeTempRoot } from '../helpers.ts'

let root = ''
let store: CortexStore

beforeEach(async () => {
  root = await makeTempRoot('dsh-cortex-seq-')
  store = new CortexStore({ root, warn: () => {} })
  await store.init()
})

afterEach(async () => {
  await removeTempRoot(root)
})

describe('postMessage seq recovery past the listing cap', () => {
  it('recovers above the highest stored message', async () => {
    const created = await store.createRoom({ title: 'seq' })
    if (!created.ok) throw new Error(created.error)
    const roomId = created.data.id
    const dir = store.paths.roomMessages(roomId)
    await mkdir(dir, { recursive: true })

    // One more than the 2000-name page `listDir` kept.
    const highest = 2001
    for (let seq = 1; seq <= highest; seq += 1) {
      const name = `${String(seq).padStart(6, '0')}.json`
      await writeFile(join(dir, name), JSON.stringify({ seq, roomId, text: `ORIGINAL-${String(seq)}`, fromKind: 'session', images: [], at: 'x' }))
    }
    await unlink(store.paths.roomSeq(roomId))

    const posted = await store.postMessage(roomId, { text: 'NEW MESSAGE' })
    if (!posted.ok || posted.data === null) throw new Error(posted.error ?? 'post returned no message')
    expect(posted.data.seq).toBe(highest + 1)

    const survivor = JSON.parse(await readFile(join(dir, `${String(highest).padStart(6, '0')}.json`), 'utf8')) as { text: string }
    expect(survivor.text).toBe(`ORIGINAL-${String(highest)}`)
  })
})
