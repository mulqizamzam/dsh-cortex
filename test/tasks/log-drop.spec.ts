/**
 * A dropped log line must never be reported as written.
 *
 * `appendMdCapped` rolls into `<stem>-2.md` … `<stem>-49.md` when a day file is
 * full, and at the 50th candidate it gives up and returns `dropped: true`
 * WITHOUT ever checking whether that last part had room (fsx.ts). `logAppend`
 * then rebuilt its ref from `rolled` only, discarding `dropped`, and the log
 * service answered `ok: true` with "logged to … (day file was full; continued
 * in the next part)" — for bytes that are nowhere on disk.
 *
 * DESIGN §3 documents overflow as "lewat -> lanjut file": continue into the next
 * part. A line that could not be continued was silently lost behind a success
 * message, which is the one thing P4 exists to prevent.
 *
 * The invariant asserted here is the honest one, independent of how the fix is
 * shaped: if the bytes are not on disk, the caller must be able to tell.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/host/config.ts'
import { CortexStore } from '../../src/host/store.ts'

let root = ''

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('a log line that could not be stored says so', () => {
  it('does not report success for bytes that never landed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-cortex-logdrop-'))
    // Every part is full after one short line, so the rollover limit is reached
    // quickly and the last candidate is the one that cannot take the line.
    const cfg = resolveConfig({ caps: { logLineChars: 24, logDayChars: 8 } } as never)
    const store = new CortexStore({ root, caps: () => cfg.caps, warn: () => {} })
    await store.init()

    const day = '2026-01-01'
    const dir = join(root, 'daily')
    await mkdir(dir, { recursive: true })
    const full = 'x'.repeat(50)
    const parts = [`${day}.md`, ...Array.from({ length: 48 }, (_, index) => `${day}-${String(index + 2)}.md`)]
    for (const name of parts) await writeFile(join(dir, name), full, 'utf8')

    const line = 'IMPORTANT-AUDIT-LINE'
    const appended = await store.logAppend({ scope: 'daily', text: line, date: day })
    if (appended.ok !== true) throw new Error(appended.error)

    let onDisk = false
    for (const name of parts) {
      const text = await readFile(join(dir, name), 'utf8').catch(() => '')
      if (text.includes(line)) onDisk = true
    }
    console.log(`LOGDROP onDisk=${String(onDisk)} droppedFlag=${String((appended.data as { dropped?: boolean }).dropped)}`)

    // The line landed, or the caller was told it did not.
    expect(onDisk || (appended.data as { dropped?: boolean }).dropped === true).toBe(true)
  })
})
