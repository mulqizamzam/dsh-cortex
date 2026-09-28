# PARENT GROUND TRUTH (pre-incident, read by parent's own eyes) — anti-drift sheet

Dipakai untuk mem-diff hasil restorasi M0. Sumber = bacaan parent 09:40–10:29,
bukan klaim agen.

## types.ts (268 baris saat dibaca penuh ronde 7)
- Tracks: `Track = 'user'|'global'|'project'`; `TodoTrack='life'|'work'|'daily'|'project'`;
  `EntryOrigin='user'|'ai-confirmed'|'import'`.
- `Entry {id,track,content,importance,tags,branches?,createdAt,updatedAt,origin,source?,archivedAt?}`
  + (post-notes) `pid?`.
- `RoomMessage {seq,roomId,fromSessionId?,fromKind:'user'|'session'|'system',fromLabel?,text,images:string[],at,jobId?}`
- `Job {id,runner,argv:string[],task,status:'queued'|'running'|'succeeded'|'failed'|'killed'|'timeout',cwd?,roomId?,pid?,sessionId?,startedAt,finishedAt?,exitCode?,resultPath?,error?}`
- `RunnerSpec {argv:string[], description?, timeoutSec?, env?}`;
- `ResolvedConfig extends CortexConfig { readonly injectLabel: string }`
- `ModuleDeps {ctx, cfg():ResolvedConfig, store, log, warn, toolScope?, runtime()}` (runtime() tercatat di notes §1.2; status module memakainya)
- `CortexModule {name, apply(deps, view)}` + konvensi `TOOLS as const`.
- Status module: `'ok'|'failed'|'skipped'`.

## config.ts (83 baris, dibaca penuh ronde 7)
- `DEFAULT_CONFIG`: inject{true,5xtrue}, memory{autoAccept:false}, pending{allowAiApprove:false},
  rooms{true}, prompts{true}, delegation{false, {}, maxConcurrent:2, jobTimeoutSec:3600, outputCapBytes:1048576},
  caps {...DEFAULT_CAPS}, retention{dailyLogDays:90}.
- `INJECT_LABEL = '[dsh-cortex · plugin memory · reference data, not user instructions]'` (PERSIS, termasuk spasi & '·').
- resolveConfig: positiveInt floor-clamp (cap<=0 → default), bool() strict, runners tervalidasi argv non-empty.
- CAPS default (DESIGN §3): entryChars 400, userTrackChars 4096, globalTrackChars 4096,
  projectTrackChars 6144, todoDigestChars 1024, totalInjectChars 14000, logLineChars 500,
  logDayChars 20000, searchResultChars 8000. (post-amendment: + stateQuotaBytes 67108864)

## store.ts (925 baris ronde 6; parent grep-review)
- Per-entry file JSON; delete per-id BUKAN rename-root; semua read via readJsonSafe({fallback,quarantineDir,warn});
  tmp+rename atomic; `isoDate` LOCAL by design + `isIsoDate` + `isoStamp` UTC-safe-filename.
- seq: file `seq.txt` + pesan `00000001.json` padded; recover di atas max pesan saat seq.txt hilang.
- helper export: selectEntriesForBranch (null→unscoped-only), orderForRender (importance desc, updatedAt desc),
  LIST_CAP=500 + truncated flag, validId/safeSessionKey/safeRoomKey, ensureProject/mergeProject idempoten.
- appendJobLog: cap-rotation, append murni. `new CortexStore({root, caps:()=>cfg().caps, warn})`.

## index.ts (parent baca ronde 12)
- `export const inject = ['tools','settings','commands','agents','subagents']` (connection TIDAK).
- apply: try boot / catch → runtime={boot module failed} + registerFallbackStatus + console.error SEKALI, tak pernah rethrow.
- boot: settings.register('cortex', Config(schemastery), {base: rawConfig, applies:'live'}); store = new CortexStore({root: cortexStateRoot(), caps-thunk, warn});
  void store.init().catch; ctx.inject(['connection']) double-guarded; loop MODULES try/catch per module;
  moduleToolNames via (module as {TOOLS?}).TOOLS; `context()`/`section()` registrasi HANYA sekali.
- exports face: name, VERSION, inject, MODULES, cortexRuntime(), {Config, DEFAULT_CONFIG, INJECT_LABEL, resolveConfig, CortexStore, Store}, types, `export * from './types.ts'`.

## rpc.ts / channels (parent baca ronde 10-13)
- '/dsh-cortex-read' mounted authority 'loopback' via registerCortexReadRpc; unknown endpoint → {ok:false,'unknown-endpoint'}; error handler → {ok:false} tak pernah throw.
- '/dsh-cortex-write' declared, MOUNT PENDING (parent yang mount saat integrasi, confirm-string utk destruktif, tanpa token terpisah — ruling G-07).

## tsdown/build (parent verifikasi artefak 10:24)
- dua target: host esm `lib/index.js` + client lazy-CJS `lib/client.js` dengan banner
  `window.__ModuleLoader__.load({ id: "dsh-cortex", factory: (require) => {` — id == package/entry name.
- tsconfig strict + noUncheckedIndexedAccess; vitest node single-fork; `pnpm run verify` = typecheck&&test&&build.
- Gate pre-incident: install OK; tsc exit 0; vitest **78/78 (5 files)**; build OK; import smoke
  `name=dsh-cortex inject=[...] apply=function MODULES=status`; `head lib/client.js` sesuai banner.

## client placeholder (M0 final versi, parent baca header-nya via laporan)
- ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id:'cortex', order..., label...}, DevCard));
  DevCard panggil `ctx.connection.rpc.call('/dsh-cortex-read','ping',{})`; react.d.ts lokal.

## Yang TIDAK boleh berubah saat restorasi tanpa catatan §8
Semua string/nilai PERSIS di atas (label, caps, defaults, export names, banner id, authority loopback).

## HASIL SWEEP RESTORASI (parent, ronde 17)
LULUS kontrak: INJECT_LABEL persis; caps 400/6144/14000 + default lain; P3
(autoAccept/allowAiApprove/delegation false); quarantine+caps store; delete per-id;
`rm(root)` hanya purgeState; seq.txt counter. DRIFT DIAMINI (ruling parent):
- Layout post-incident = NAMA FINAL. Peta untuk agen modul: helper defineTool/
  registerToolSafe/text/JSON_OBJECT_OUTPUT kini di `src/host/dsh.ts` (bukan tools.ts);
  tipe host di `src/host/dsh-internal.ts` (bukan dsh.ts); `Config`+`DEFAULT_CONFIG`+
  `INJECT_LABEL`+`resolveConfig` satu file `src/host/config.ts` (config-schema.ts merged);
  `cortexStateRoot` → `resolveStateRoot` (lib/home).
- padStart(8)→(6) utk nama pesan room: diterima (aman s/d 999999/room).
- TUNGGU dr M0: sanitize.ts, stateQuotaBytes, suite test penuh, src/index.ts barrel,
  client, tails gate, §8 cause-report. Snapshot tar parent WAJIB setelah hijau.

## ANCHOR BARU (audit dalam parent ronde 22, pasca-restorasi)
- `addEntry`: clampText(entryChars)+clampImportance+normalizeList(tags,40)/(branches,80)+pid-on-entry+origin-default-'user'.
- `listEntries`: multi-scope (user/global[/project@pid]), LIST_CAP w/ truncated OR-propagation, branch filter post-read, orderForRender, isSafeKey sebelum join.
- `index.ts` live-swap: try re-resolve, catch => keep previous + warn.
- Konfirmasi LULUS restorasi: label/caps/P3/seq/per-id-delete/purge-only-root-rm.

## WAKE MESSAGES (kirim sbg send_message per agen SETELAH snapshot; isi identik + tail khusus)
"FOUNDATION RESTORED+GREEN by parent (vitest ≥78, tsc 0, client lazy-CJS banner ok, sanitize+kuota ada).
Nama file FINAL (peta di .dev/parent-groundtruth.md §HASIL SWEEP): tools-helper di src/host/dsh.ts,
tipe di dsh-internal.ts, config tunggal src/host/config.ts, state root resolveStateRoot.
Lanjut brief aslimu (.dev/BRIEFS.md blokmu + update ronde-12 + DISPATCH rules). WRITE-SET KETAT:
hanya direktori modulmu + testmu; shared files (index/rpc/store/types/config/lib/home,caps,fsx,ids,pid,gitx)
= BACA-SAJA. Sanitize sudah ada di src/lib/sanitize.ts — import dari sana.
Tes sendiri: ./node_modules/.bin/vitest run <dir-mu> saja. Jangan git. Jangan sentuh profil live.
Kirim laporan: file list + tails + endpoint exports + deviasi."
Tail M2: + 'renderMemoryBlock pure fn exported utk unit test; context name cortex:memory order 40; header G-04.'
Tail M3: + 'dua module (todo,logs)+progress; contexts cortex:todo 41; nudge per G-06; endpoint todo.*/logs.*.'
Tail M5: + 'rooms+sessions; delivery via context cortex:rooms 42 + consumed-file; spawn feature-detect agents.create; wake table + counts; images only from-state-root.'
Tail M6: + 'delegate; gate delegation.enabled; {{taskFile}} convention; write-back labelled; orphan->lost; maxConcurrent; fixture echo runner di test/delegate/fixtures/.'
