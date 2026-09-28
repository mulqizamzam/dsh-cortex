#!/usr/bin/env node
// M6 test fixture: floods stdout with ~argv[0] KB of numbered lines so the
// per-stream byte cap (delegation.outputCapBytes) can be asserted on disk.
const kb = Number(process.argv[2] ?? '200')
const lines = []
for (let i = 0; i < kb * 10; i += 1) {
  lines.push(`line-${String(i).padStart(6, '0')} ${'x'.repeat(96)}`)
}
lines.push(`SPAM-DONE ${String(kb)}kb`)
// Write once and exit only after the pipe accepted everything — an early
// process.exit() would drop buffered stdout and defeat the cap test.
process.stdout.write(`${lines.join('\n')}\n`, () => process.exit(0))
process.stdout.on('error', () => process.exit(0))
