// Bandingkan status.tools (dari cortex_status) vs registry nyata (ToolRuntime.get
// lewat host) — registry dibaca tidak langsung: bundle mendeklarasikan 34 id, dan
// tool yang benar-benar ter-mount bisa dipanggil. Di sini kita bandingkan daftar
// status dengan deklarasi bundle + cek tiap id punya definisi di bundle host.
import { readFileSync } from 'node:fs'
const host = readFileSync('/home/administrator/deepseek-harness/packages/core/tools/src/index.ts', 'utf8')
const registryLookup = /get\(name: string, scope\?: ScopeKey\): ToolDefinition \| undefined \{/.test(host)
const bundle = readFileSync('lib/index.js', 'utf8')
const declared = new Set([...bundle.matchAll(/name:\s*"(cortex_[a-z_]+)"/g)].map(m => m[1]))
const reported = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const flat = reported.modules.flatMap(m => m.tools)
const notInBundle = flat.filter(id => !declared.has(id))
const neverReported = [...declared].filter(id => !flat.includes(id))
const dupes = flat.filter((id, i) => flat.indexOf(id) !== i)
console.log(JSON.stringify({
  hostHasRegistryLookup: registryLookup,
  bundleDeclaredIds: declared.size,
  reportedIds: flat.length,
  reportedUnique: new Set(flat).size,
  duplicates: dupes,
  reportedNotInBundle: notInBundle,
  declaredNeverReported: neverReported,
  moduleStates: reported.modules.map(m => `${m.name}:${m.state}:${m.tools.length}`),
}, null, 1))
