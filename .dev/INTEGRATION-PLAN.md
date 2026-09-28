# INTEGRATION PLAN (parent ledger — eksekusi berurutan, anti-hilang saat compaction)

## A. Gerbang fondasi (SEBELUM wake)
1. tails M0 masuk → parent jalankan sendiri: vitest (>=78 pass), tsc exit 0, build,
   `head -c 80 lib/client.js` == `window.__ModuleLoader__.load({ id: "dsh-cortex"` ,
   node -e import smoke, src/lib/sanitize.ts ada + diuji, stateQuotaBytes ada di caps
   & ditegakkan store.addEntry (read kodenya), §8 M0-NOTES terisi (cause + diff table).
2. `tar czf .dev/snapshots/FOUNDATION-$(date +%H%M).tgz --exclude node_modules --exclude .pnpm-* --exclude g4-home .`
3. BARU kirim 4 wake messages (teks: parent-groundtruth.md §WAKE MESSAGES).

## B. Selagi gelombang-1 jalan (M2,M3,M5,M6)
- Parent TIDAK menulis src/** sama sekali (window penulis = agen).
- Pantau hanya direktori baru modul via find; tidak ada polling agresif; ignore
  angka di laporan agen sampai direcount.
- Sambil nunggu: update .local-link.md skeleton (konvensi 8 seksi) + baca REVIEW
  lama R1 kalau dia sempat menumpuk sesuatu di konteksnya (opsional).

## C. Integrasi wave-1 (parent satu-satunya penulis shared files)
1. src/host/index.ts: import + MODULES += memory, todo, logs, progress, rooms, sessions, delegate.
2. src/host/rpc.ts: tambah mountCortexWriteRpc + penggabungan writeEndpoints modul
   (registry param); index.ts memanggilnya di blok connection yang sama (authority
   loopback). Endpoint destruktif tetap butuh confirm-string per contract.
3. Config: promosi konstanta modul yang layak (prompts.stickyMaxTurns dsb.) ke
   config.ts + types.ts + config-schema bila M4 nanti minta; catat di NOTES.
4. Gate penuh: pnpm verify (typecheck+test+build) + grep: `webServer` 0 hit dist,
   `{{` 0 hit di string description tool (G14/G7 awal), label G-04/G-03 persis.
5. SNAPSHOT snapshot snapshot. (RULE)
6. Kirim DISPATCH2 (M4 dulu, M7 paralel).

## D. Gelombang-2 settle → integrasi-2
- MODULES += prompts; client M7 masuk; rebuild; gate ulang; snapshot.
- G3/G4/G5 harness jalan penuh (.dev/g4-harness.sh prep/compose/boot/corrupt/uninstall
  — modifikasi boot(): assertions = mount-line + 'cortex_status' tool list + 0 fatal;
  corrupt(): schema.json rusak + 1 entry json rusak → host hidup + karantina muncul).
- G10 room e2em + G11 delegate e2e pakai hermes bila tersedia (kalau butuh key ->
  skip ber-alasan + fixture echo runner tetap lulus) — via throwaway host + CLI
  `dsh --profile headless` BILA ada; kalau tidak, tandai MANUAL-OPERATOR.
- R1-integrasi (reviewer baru, scope sempit: constraint table + security sweep) +
  fix round; gerbang terakhir G1..G16 status terisi jujur di TEST-PLAN.
- README: ganti [VERIFY-BEFORE-RELEASE] hanya yang ada bukti; .local-link.md final
  + laporan akhir ke operator + KEPUTUSAN operator: install ke profil web live
  (butuh restart GUI) — JANGAN dilakukan tanpa GO.

### C.0 Daftar permintaan agen (terkumpul)
M6 (DELIVERED 13/13 x7run): +JobStatus 'lost' & Job.projectId? di types.ts; mount
delegateEndpoints {read,write} (bentuk peta per modul, BUKAN readEndpoints terpisah);
append jobs.get + jobs.result ke RPC-ENDPOINTS; JANGAN "perbaiki" double-write
createJob->updateJob (sengaja); JANGAN tambah getJob/tailStream ke store (M6 pegang);
cortex_agent_delegate TUNDA (P1, tercatat). Catatan parent: M0-NOTES §1.4 daftar
job-API tidak akurat utk store hasil restorasi — pakai isi disk nyata.

### C.0.1 TEMUAN CROSS-MODUL (parent, ronde 44) — WAJIB saat integrasi
- `pending.approve` di peta M2 = KHUSUS kind 'memory' (approvePendingMemory). Queue punya 3 kind.
  Parent REPLACES entry 'pending.approve' dg DISPATCHER by item.kind → approver modul terkait
  (memory=M2 PENDING_OPS.approve; todo=approver M3—cek ekspor mereka; prompt=M4 nanti).
  'pending.reject' harus kind-agnostic (cek implementasi M2 saat mount).
- M5: direktori `sessions/` belum muncul (5f di rooms saja) — kemungkinan digabung; minta
  klarifikasi di laporan M5 (bukan rombak; catat sebagai deviasi).
- Bentuk endpoint beda2 (M2 statis+deps; M3/M6 factory/service) — adapter per modul di index.ts,
  jangan paksakan satu bentuk.

### C.0.2 Keputusan dari laporan M2 (parent, ronde 53)
- PROMOSI `PendingItem['proposal'].pid?: string` di types.ts (setuju; panel tak perlu re-supply
  projectId/cwd saat approve proyek). Update M2 ops.ts baca field itu -> cek saat mount.
- Known limitation diterima utk v1 & catat README: seam context() SINKRON => render sesi baru
  satu turn ahead (turn pertama '', setelah itu memo 5s/refresh<=30s). Jangan switch ke
  waterfall per-agent (biaya listener churn) tanpa bukti keluhan nyata.
- M7 mock WAJIB baca `value.entries` / `value.hits` (bukan array mentah) — flag ke DISPATCH2.
- pending.approve M2 sudah kind-guard internal (refuse non-memory) => dispatcher parent tetap
  jalan lebih dulu by-kind; approver memory = fungsi M2 (bukan map entry-nya, agar tak dobel-guard).
- apply(deps, options?) M2 kompatibel dgn loop (arg 2 opsional) ✓.

### C.0.3 Status jendela integrasi (parent, ronde 54)
- types.ts LUAS selesai & tsc-verified: PendingItem.proposal.pid?, JobStatus +'"'"'lost'"'"', Job.projectId?.
  Delegate masih pakai CreateJobInput widened-local (tdk rusak; boleh disederhanakan nanti — NON-BLOCKING).
- SELURUH PAKET tsc --noEmit EXIT=0 (M3 bereskan 28 error test/tasks sendiri). Sinyal window hampir bersih.
- Menunggu laporan settle M3 (test/tasks 7 spec) + M5 (sessions 4 file + test/rooms 6 spec). denyut 13:10.
- Setelah dua2nya: EDIT-A/B (index-wiring.md) apply -> vitest penuh + build + integration-checks C1-C12 -> snapshot INTEGRATED -> DISPATCH2.
- RECOUNT tercatat: M6 13/13 (parent), M2 69/69 (parent). M3/M5 akan direcount saat integrasi.

### PETA CONTEXT (anti-crash registrasi; verified grep ronde 55)
- cortex:memory=40 (M2), cortex:todo=41 (M3), cortex:rooms=42 (M5), cortex:logs(nudge)=44 (M3).
- cortex:prompts=43 RESERVED utk M4 (DISPATCH2 sbb order 43). Jangan pakai 44 (logs ambil).
- Semua unik => tak ada "already registered" throw saat MODULES wiring. C4 check bandingkan dgn peta ini.
- progress module = tools-only, endpoints {} (verified). delegate endpoints {read,write} via svc.

### C.0.4 PRE-INTEGRATION SNAPSHOT (parent-run, 13:30 — INFORMASIONAL, window belum resmi bersih)
- vitest PAKET PENUH: 20 files / 304 tests SEMUA HIJAU (termasuk M3 test/tasks 7 file & M5 test/rooms 6 file).
- tsc paket exit 0. Konteks 40/41/42/44 unik. M2 tetap 69/69 pasca patch fallback pid parent.
- denyut tulis terakhir 13:28:49; M3/M5 belum setor laporan -> TUNGGU settle resmi sebelum EDIT-A/B
  (aturan: agen pasca-laporan bisa rewind; jangan pernah jadi penulis kedua).
- Perkiraan: integrasi = 1 jendela (wiring + mount + dispatcher) -> gate ulang -> snapshot INTEGRATED -> DISPATCH2.

### WAVE-1 INTEGRATION COMPLETE (parent, 15:24) — SNAPSHOT INTEGRATED-1524.tgz
- index.ts: 8 modules wired, read+write loopback channels, endpoint merge (first-writer-wins+warn),
  pending.approve BY-KIND dispatcher. types.ts: JobStatus 'lost'+Job.projectId?+proposal.pid.
  config: logReview.everyTurns promoted (opt type, always filled). M2 seam 2->1-arg BUGFIX +
  hardened fake; M3/M5 seams were already correct; M2 approve reads proposal.pid fallback.
- GATES parent-run: vitest 305/305 (21 files), tsc 0, build 0, integration-checks C1-C12 exit 0.
- entry.spec updated to wired contract (8 modules, 2 channels, tools.size>20 on collision).
- NEXT (wave-2, dispatched): M4 prompts, M7 UI; then R2 integration review + G3/G4/G10/G11 e2e.

### POST-WIRING E2E (parent, 15:42) — SNAPSHOT INTEGRATED-1542
- G4 REAL BOOT (throwaway DSH_HOME, web --port 0): host hidup, "ready — 8x ok", contexts
  registered, state root terbentuk, logReview terisi default 0. PASS.
- G3 CORRUPT: schema.json + user/entry korup -> HOST_ALIVE + quarantine/.corrupt-* muncul.
  PASS (kelas pembunuh GUI memory-evolve tuntas).
- ARTIFACT E2E (lib/index.js nyata, tanpa LLM): 11/11 PASS — journey remember->pending.list
  (endpoint BARU dipasang parent karena gap kontrak) -> approve by-kind -> entry masuk list +
  context render (two-call one-step-ahead sesuai desain M2) -> corrupt entry survive+karantina.
- sessions.hostCanSpawn: TRUE di web host nyata, FALSE di fake node (degradasi jujur keduanya).
- 2 error tsc saat ini = src/client/dom.d.ts (M7 in-flight, BUKAN milik parent/wave-1).
- TUNGGU: laporan settle M4/M7/R2 -> gate ulang penuh + build + checks + snapshot -> toolprobe
  (perlu NINE_ROUTER_API_KEY di shell operator — tidak ada di tool-shell; jadi langkah operator
  atau temukan jalur aman tanpa membaca nilai) -> docs final + laporan.

## E. Invariants yang tidak boleh dilupakan
- Live profile tidak tersentuh; throwaway-only; node_modules plugin = store lokal
  (pnpm-workspace.yaml) JANGAN dipromosikan ke config global.
- Laporan agen = klaim; angka dari mulut sendiri; subagen bisa rewind — snapshot
  setelah tiap gerbang.
- WRITE channel TANPA token (ruling G-07), tapi confirm-string utk destruktif +
  hanya loopback-fence; jangan pernah daftarkan route webServer.
- INJECT_LABEL byte-exact; semua model-visible text lewat neutralize(); todo digest
  & prompt queue pakai context name terdaftar SEKALI di apply().
