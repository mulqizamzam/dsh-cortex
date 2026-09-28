import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Test plumbing: every suite gets a unique directory under os.tmpdir() and
 * passes it in explicitly, so no test can touch the real $DSH_HOME.
 */
export async function makeTempRoot(prefix = 'dsh-cortex-test-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/**
 * Delete a tmp root. Retries because the plugin entry scaffolds state with a
 * fire-and-forget `store.init()`, so a directory can reappear a microtask after
 * the test body settles.
 */
export async function removeTempRoot(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY') throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  await rm(path, { recursive: true, force: true }).catch(() => {})
}
