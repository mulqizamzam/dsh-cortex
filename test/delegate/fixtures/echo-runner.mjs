#!/usr/bin/env node
// M6 test fixture: the "echo runner". Prints what it ACTUALLY received
// (argv items, cwd, probe env var) as one JSON line on stdout, and the
// content of any argv item that names a readable file — that is how the
// tests prove the task arrived as one argv item or via the task.md file,
// never as separate flags. Exits 0. No network, no shell.
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const files = {}
for (const item of argv) {
  try {
    files[item] = readFileSync(item, 'utf8')
  } catch {
    // not a readable path — data, not a file reference
  }
}
process.stdout.write(`${JSON.stringify({ echo: 'dsh-cortex-m6-fixture', argv, cwd: process.cwd(), probe: process.env.CORTEX_FIXTURE_PROBE ?? null, files })}\n`)
process.exit(0)
