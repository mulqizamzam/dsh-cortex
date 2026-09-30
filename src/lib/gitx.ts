import { spawn } from 'node:child_process'

/**
 * Read-only git probes for branch scoping (DESIGN §2, P7).
 * argv ARRAY only — never a shell string, never user text as a flag.
 * Every function resolves `undefined` on any failure: a plain directory, a
 * detached HEAD, a missing git binary and a permission error are all normal.
 */

/** Hard ceiling so a wedged repo can never stall the host turn. */
export const GIT_TIMEOUT_MS = 2000

/** Run one git command with an argv array; trimmed stdout or undefined. */
export function runGit(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string | undefined> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(undefined)
      return
    }
    let output = ''
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // A dead handle cannot be killed; the promise is already settling.
      }
      finish(undefined)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 4096) finish(undefined)
    })
    child.on('error', () => finish(undefined))
    child.on('close', code => finish(code === 0 ? output.trim() : undefined))
  })
}

/** Active branch (`git branch --show-current`), or undefined. */
export function currentBranch(cwd: string): Promise<string | undefined> {
  return runGit(['-C', cwd, 'branch', '--show-current'], cwd)
}

/** Repository toplevel (`git rev-parse --show-toplevel`), or undefined. */
export function repoRoot(cwd: string): Promise<string | undefined> {
  return runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd)
}

/** `origin` URL, or undefined. */
export function originRemote(cwd: string): Promise<string | undefined> {
  return runGit(['-C', cwd, 'config', '--get', 'remote.origin.url'], cwd)
}

/**
 * Structured branch-scope test (P8 — never parsed out of text).
 * `branch === null` means UNKNOWN: only unscoped entries match.
 */
export function branchMatches(scopes: readonly string[] | undefined, branch: string | null): boolean {
  if (scopes === undefined || scopes.length === 0) return true
  return branch !== null && scopes.includes(branch)
}
