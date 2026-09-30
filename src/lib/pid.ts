import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'

/**
 * Stable project identity (DESIGN §2): 16 hex of
 * `sha256(normalizedRemote || realpath(cwd))`. The remote wins so one repo keeps
 * one project id across checkouts and worktrees.
 */

/**
 * `git@host:o/r.git`, `https://user:tok@Host/o/r.git`, `ssh://git@h:22/o/r`,
 * `git://h/o/r/` → `h/o/r`. Pure, no fs, no network, never throws.
 * Host is lower-cased (it is case-insensitive); the path keeps its case.
 */
export function normalizeGitRemote(input: string | undefined | null): string | undefined {
  if (typeof input !== 'string') return undefined
  let value = input.trim()
  if (value === '') return undefined
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value)
  if (scheme !== null) value = value.slice(scheme[0].length)
  if (value.includes('@')) value = value.slice(value.indexOf('@') + 1)
  const colon = value.indexOf(':')
  const slash = value.indexOf('/')
  // A `:` before any `/` is scp-style (`host:path`) unless what follows is a port.
  if (colon !== -1 && (slash === -1 || colon < slash) && !/^\d+(\/|$)/.test(value.slice(colon + 1))) {
    value = `${value.slice(0, colon)}/${value.slice(colon + 1)}`
  }
  const parts = value.split('/')
  const host = (parts.shift() ?? '').toLowerCase().replace(/:\d+$/, '')
  if (host === '') return undefined
  const path = parts.join('/').replace(/\/+$/, '').replace(/\.git$/, '')
  return path === '' ? `${host}/` : `${host}/${path}`
}

/** 16 hex chars of sha256. */
export function hashId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

/** realpath, or the trimmed input when the path is unreadable. */
export async function canonicalCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd)
  } catch {
    return String(cwd ?? '').trim()
  }
}

/** Project id for a workspace: remote-derived when a remote is known. */
export async function projectId(input: { cwd: string; remoteUrl?: string | undefined }): Promise<string> {
  const remote = normalizeGitRemote(input.remoteUrl)
  if (remote !== undefined && !remote.endsWith('/')) return hashId(remote)
  return hashId(await canonicalCwd(input.cwd))
}
