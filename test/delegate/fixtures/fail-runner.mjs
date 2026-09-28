#!/usr/bin/env node
// M6 test fixture: the "fail runner". Always exits with a non-zero code
// so tests can verify auto-retry and dead-letter behaviour. Prints a
// marker to stdout so the test can count attempts. No network, no shell.
const attempt = process.env.CORTEX_FIXTURE_ATTEMPT ?? '0'
process.stdout.write(`FAIL-ATTEMPT ${attempt}\n`)
process.exit(1)
