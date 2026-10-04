#!/usr/bin/env node
// M6 test fixture: the "quiet runner". Exits 0 with NOTHING on stdout or
// stderr. Proves a successful job that produced no output must NOT create a
// memory proposal — there is nothing a human could confirm or reject.
process.exit(0)