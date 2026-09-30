import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { errorMessage } from './errors.ts'
import { isoStamp } from './ids.ts'

/** Sink for every silent-catch path; P4 requires that "never throws" stays visible. */
export type WarnFn = (message: string) => void

/** Read options: fallback + where corrupt files are moved. */
export interface ReadJsonOptions<T> {
  fallback: T
  quarantineDir: string
  warn?: WarnFn
}

/**
 * Parse JSON without ever throwing (P4). Absent/empty file = fallback quietly.
 * A corrupt file is MOVED to `quarantine/<name>.corrupt-<iso>` so the same
 * bytes cannot re-fail on every boot.
 */
export async function readJsonSafe<T>(path: string, options: ReadJsonOptions<T>): Promise<T> {
  const warn = options.warn
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn?.(`${basename(path)}: unreadable (${errorMessage(error)})`)
    return options.fallback
  }
  if (raw.trim() === '') return options.fallback
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    const target = join(options.quarantineDir, `${basename(path)}.corrupt-${isoStamp()}`)
    try {
      await mkdir(options.quarantineDir, { recursive: true })
      await rename(path, target)
      warn?.(`${basename(path)}: invalid JSON (${errorMessage(error)}); quarantined to ${target}`)
    } catch (moveError) {
      warn?.(`${basename(path)}: invalid JSON and quarantine move failed (${errorMessage(moveError)}); using fallback`)
    }
    return options.fallback
  }
}

/** Whole file as text, or null when absent. */
export async function readTextSafe(path: string, warn?: WarnFn): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn?.(`${basename(path)}: unreadable (${errorMessage(error)})`)
    return null
  }
}

/**
 * Atomic write: temp file in the SAME directory + rename. An interrupted write
 * leaves the previous target or a `.`-prefixed orphan (ignored by listDir).
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Append one capped line; day-cap overflow rolls into `<stem>-2.md`, `-3.md`, … */
export async function appendMdCapped(
  file: string, line: string, lineCap: number, dayCap: number,
  clamp: (text: string, max: number) => string, warn?: WarnFn,
): Promise<{ path: string; rolled: boolean; dropped: boolean }> {
  const entry = clamp(line, lineCap)
  if (entry === '') return { path: file, rolled: false, dropped: true }
  const payload = `${entry.replace(/\n/g, ' ')}\n`
  await mkdir(dirname(file), { recursive: true })
  const ext = file.endsWith('.md') ? '.md' : ''
  const stem = ext === '' ? file : file.slice(0, -ext.length)
  let target = file
  let rolled = false
  for (let index = 2; index <= 50; index += 1) {
    const size = await sizeOf(target)
    if (size === null || size + payload.length <= dayCap) break
    target = `${stem}-${String(index)}${ext}`
    rolled = true
    if (index === 50) {
      warn?.(`${basename(file)}: rollover limit reached; line dropped`)
      return { path: target, rolled, dropped: true }
    }
  }
  await writeFile(target, payload, { flag: 'a' })
  return { path: target, rolled, dropped: false }
}

/** Byte size, or null when absent. */
export async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

/**
 * Total bytes under a directory, from one recursive stat walk, stopping as soon
 * as `stopAfter` is exceeded (so an already-over-quota root costs one hit).
 * Unreadable entries are skipped, never thrown (P4). A missing root is 0.
 */
export async function dirBytes(dir: string, stopAfter = Number.POSITIVE_INFINITY): Promise<number> {
  let total = 0
  let pending: string[] = [dir]
  while (pending.length > 0) {
    const current = pending.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(join(current, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const size = await sizeOf(join(current, entry.name))
      if (size === null) continue
      total += size
      if (total > stopAfter) return total
    }
  }
  return total
}

/** Sorted names in a directory, capped (P2). Missing dir = empty. Dot-files skipped. */
export async function listDir(dir: string, cap: number): Promise<{ names: string[]; truncated: boolean }> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { names: [], truncated: false }
  }
  const names = entries.filter(name => !name.startsWith('.')).sort()
  if (names.length <= cap) return { names, truncated: false }
  return { names: names.slice(0, cap), truncated: true }
}

/**
 * Every sorted name in a directory, UNCAPPED. Dot-files skipped, missing dir = [].
 *
 * `listDir` keeps the OLDEST `cap` names; callers that need the NEWEST rows (a
 * day that is newer than the page, a message past the page) must select from the
 * full set here and then apply their own predicate, or they silently read a
 * stale page.
 */
export async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(name => !name.startsWith('.')).sort()
  } catch {
    return []
  }
}
