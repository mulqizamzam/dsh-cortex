# INTEGRATION WIRING PATCH (final shapes confirmed 12:49)
Semua 7 modul ekspor face seragam: {name, TOOLS, apply, readEndpoints, writeEndpoints}.
Progress memakai peta kosong {} (tools-only) ✓ aman di-merge.
Rooms memakai bindRoomsEndpoints(...) — modul bind service internal; peta tereksport
tetap nama final (cek bind dipanggil saat apply; kalau belum, endpoint jawab not-wired
versi mereka — jujur, tidak perlu diubah).

## EDIT-A src/host/index.ts
import baris tambahan (setelah `import * as statusModule ...`):
```ts
import * as memoryModule from './modules/memory/index.ts'
import * as todoModule from './modules/todo/index.ts'
import * as logsModule from './modules/logs/index.ts'
import * as progressModule from './modules/progress/index.ts'
import * as roomsModule from './modules/rooms/index.ts'
import * as sessionsModule from './modules/sessions/index.ts'
import * as delegateModule from './modules/delegate/index.ts'
// M4 nanti: import * as promptsModule from './modules/prompts/index.ts'
```
MODULES array jadi:
```ts
type EndpointsModule = CortexModule & {
  readEndpoints?: Record<string, (payload: unknown, deps: ModuleDeps) => Promise<HostRpcResult<unknown>>>
  writeEndpoints?: Record<string, (payload: unknown, deps: ModuleDeps) => Promise<HostRpcResult<unknown>>>
}
export const MODULES: EndpointsModule[] = [statusModule, memoryModule, todoModule, logsModule, progressModule, roomsModule, sessionsModule, delegateModule /*, promptsModule*/]
```
(catatan: apply(deps) signature seragam — cek memory apply DEPS+VIEW? baca saat edit;
loop hanya lewat module.apply(deps), view arg opsional JS.)

## EDIT-B dispatcher + mount (blok connection, ganti handler inline read-only):
```ts
const readMap: Record<string, (p: unknown, d: ModuleDeps) => Promise<HostRpcResult<unknown>>> = {}
const writeMap: Record<string, (p: unknown, d: ModuleDeps) => Promise<HostRpcResult<unknown>>> = {}
for (const m of MODULES) {
  for (const [k, h] of Object.entries(m.readEndpoints ?? {})) {
    if (readMap[k]) log.warn(`duplicate READ endpoint '${k}' from ${m.name} ignored`); else readMap[k] = h
  }
  for (const [k, h] of Object.entries(m.writeEndpoints ?? {})) {
    if (writeMap[k]) log.warn(`duplicate WRITE endpoint '${k}' from ${m.name} ignored`); else writeMap[k] = h
  }
}
// PENDING.APPROVE DISPATCHER by-kind (parent-owned; M2 memory-only map entry replaced):
const memoryApprove = readMap['pending.approve'] ? null : writeMap['pending.approve']
writeMap['pending.approve'] = async (payload, d) => {
  const id = (payload as { id?: unknown })?.id
  const found = await d.store.listPending({ limit: 500 }).then(r => r.ok ? r.data.find(p => p.id === id) : undefined)
  if (!found) return { ok: false, error: { code: 'not-found', message: 'no pending proposal with that id' } }
  if (found.kind === 'memory') return memoryApprove ? memoryApprove(payload, d) : { ok: false, error: { code: 'internal', message: 'memory approver missing' } }
  return { ok: false, error: { code: 'unsupported-kind', message: `no approver wired for pending kind '${found.kind}'` } }
}
// M4 nanti: tambahkan cabang kind === 'prompt' → promptsModule approve.
const dispatcher = (side: 'read' | 'write', map: typeof readMap) => async (endpoint: string, payload: unknown): Promise<HostRpcResult<unknown>> => {
  if (side === 'read' && endpoint === CORTEX_PING_ENDPOINT) return { ok: true, value: { /* existing ping body */ } }
  const handler = map[endpoint]
  if (!handler) return { ok: false, error: { code: 'unknown-endpoint', message: `unknown cortex ${side} endpoint: ${String(endpoint)}` } }
  try { return await handler(payload, deps) }
  catch (error) { return { ok: false, error: { message: errorMessage(error) } } }
}
connection.rpc.handle(CORTEX_READ_CHANNEL, dispatcher('read', readMap), { authority: 'loopback' })
connection.rpc.handle(CORTEX_WRITE_CHANNEL, dispatcher('write', writeMap), { authority: 'loopback' })
```
(Loop collection WAJIB jalan SETELAH modules loop (apply) — service-bound maps
mengisi sendiri; peta statis tidak berubah. deps sudah ada di scope boot.)

## EDIT-C types.ts: JobStatus += 'lost'; Job.projectId?: string.
## EDIT-D rpc-channels.ts: export CORTEX_WRITE_ENDPOINT_NAMES list utk tes/diag (opsional).
## EDIT-E .dev/RPC-ENDPOINTS.md: append jobs.get, jobs.result + catatan pending.approve dispatcher.

## GATE SETELAH PATCH (parent):
./node_modules/.bin/tsc --noEmit -p tsconfig.json → 0
timeout 300 ./node_modules/.bin/vitest run → semua file hijau; catat TOTAL
./.dev/parent-fixes/integration-checks.sh → exit 0 (C1..C12; isi ping body jangan sampai hilang)
pnpm run build → banner + host ok
node -e smoke import lib/index.js → MODULES list 7+
tar snapshot → .dev/snapshots/INTEGRATED-<time>.tgz
LALU: kirim DISPATCH2 (M4, M7) + R2 reviewer.
