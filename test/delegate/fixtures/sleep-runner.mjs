#!/usr/bin/env node
// M6 test fixture: sleeps argv[0] ms (default 60000), then exits 0.
// Used for timeout/cancel/maxConcurrent paths. SIGTERM/SIGKILL land via the
// process group; node dies on default signal handling.
const ms = Number(process.argv[2] ?? '60000')
process.stdout.write(`sleeping ${String(ms)}ms pid ${String(process.pid)}\n`)
setTimeout(() => process.exit(0), Number.isFinite(ms) ? ms : 60000)
