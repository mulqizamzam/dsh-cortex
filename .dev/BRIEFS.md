# IMPLEMENTATION BRIEFS — M2..M7 (dikontrakkan dari DESIGN.md + docs/HOST-API.md)

Semua agen WAJIB baca dulu: `DESIGN.md`, `docs/HOST-API.md` (final; abaikan sitasi
draft RECON-SDK §lama), `.dev/M0-NOTES.md` (interface store/lib aktual),
`.dev/recon/RECON-SCENARIOS.md` §2 constraints (C-xx). Aturan umum: tulis HANYA di
write-set masing-masing; file baru via edit/append, JANGAN format ulang file orang;
setiap tool dibungkus `registerToolSafe`; jangan pernah throw dari `apply`; angka
test harus nyata (jalan-kan, jangan dikarang).

> UPDATE 2026-09-15 (recon skenario final): DESIGN §0 **P9** baru — semua teks
> model-visible wajib `neutralize()` dari `src/lib/sanitize.ts` (kelas regresi
> issue #53: `{{session}}` di memori = renderer section host throw = sesi mati
> total). §9.1 G-07 ruling: save config UI = read-modify-write OBJEK PENUH + cek
> revision (regresi #44), toggles hanya via kanal write ter-fence. M5: wake
> disposition idle→wake / running→pre-step / offline→skip + hitusan jujur. Caps
> baru: stateQuotaBytes. Tes baru: G14/G15/G16 di TEST-PLAN.

---

> UPDATE ronde-12 (kontrak modul FINAL, dibaca dari kode jadi): module = file dengan
> `export const name`, `export const TOOLS = ['cortex_...'] as const` (dipakai status
> report), `export function apply(deps: ModuleDeps, view): void`. deps = {ctx, cfg(),
> store, log, warn, runtime()}. Tool via `defineTool` dari `src/host/tools.ts` +
> `registerToolSafe`. Conhat wiring di `src/host/modules/status/index.ts` (eksplisit:
> itu template kalian). Registrasi `systemPrompt.context` SEKALI di apply() (duplikat =
> throw). M2..M6 juga WAJIB mount endpoint RPC-nya: helper `registerCortexReadRpc` sudah
> ada; pola endpoint registry可扩展 di `src/host/rpc.ts` — append dispatch kalian lewat
> `deps` yang disediakan (lihat signature RpcDeps), JANGAN meregister channel baru.
> WRITE channel (`/dsh-cortex-write`) disediakan M0 dengan pola sama; endpoint tulis
> mematuhi: konfirmasi string persis utk destruktif, payload tervalidasi tipe manual.

## M2 · Memory domain
Write-set: `src/host/modules/memory/**` + `test/memory/**`
Beri: implementasi penuh §DESIGN-4 memori.
- **SEAM INJEKSI (revisi parent 11 — verifikasi source terakhir)**: PAKAI
  `ctx.get('systemPrompt').context('cortex:memory', { order: 40, text: (c) => … })` —
  callback dievaluasi PER ASSEMBLY dan TIDAK ADA argumen = konteksnya {agent,scope,signal}
  saat dipanggil dari agent-loop (host `core/agent/src/dispatch.ts:174` menyuntik `agent`;
  tipe dasar `AssembleContext` cuma deklarasikan scope/signal → cast `c as {agent?: HostAgent}`;
  `agent` absen = contribute ''). Satu registrasi global, scoping per-sesi via
  `agent.session.header.cwd` + branch live. ATURAN: name unik ('cortex:memory'; duplikat
  = throw — daftarkan SEKALI di apply()), text selalu diawali label jujur + lewat
  neutralize(). FALLBACK bila runtime mengecewakan: waterfall per-agent
  `agent.ctx.on('system-prompt/assemble', …)` pola `dsh-mnemon/src/host/lifecycle.ts:274,:1032`.
  Tulis tes yang membuktikan agent ada di konteks (mock ctx tidak perlu: unit-render saja
  functions murni `renderMemoryBlock(cwdOrNull)`; integrasi asli di G4).
- Tools: cortex_memory_remember/search/list/archive/restore/delete/update (kontrak + pending-gate sesuai §DESIGN-4; delete dua-konfirmasi).
- Injeksi: modul listen `system-prompt/assemble` ATAU seam global `ctx.get('systemPrompt').section('cortex:memory', order 40)` — PILIH section global (paling sederhana, satu jalur render). Render per-track dengan caps §DESIGN-3, urutan user→global→project(branch-filtered), header persis G-04, footer omit `[… N more entries omitted — see Cortex panel]`, total ≤ caps.totalInjectChars. Branch via `gitx.currentBranch(cwd dari agent)`; unknown → hanya unscoped.
- Search: substring + token-overlap ranking lokal (tanpa dependensi), lintasan: entries aktif+archive per project/global/user; output ≤ caps.searchResultChars, tiap hit = id + track + snippet ±160 char.
- Acceptance tests: caps ditegakkan (500 entri sampah → ≤ budget), label jujur ada di SETIAP jalur render (G9), branch filter exact (termasuk branch=null), archive↔restore tidak hilang data, file korup → karantina (pakai primitif M0, jangan bikin lagi).

## M3 · Todo + logs + progress
Write-set: `src/host/modules/todo/**`, `src/host/modules/logs/**`, `src/host/modules/progress/**` + `test/tasks/**`
- Tools: cortex_todo_add/list/complete/remove (4 track; project-track keyed pid), cortex_log_append/read (project+daily, cap per line/day), cortex_progress_report.
- Todo digest ≤ caps.todoDigestChars masuk blok injeksi M2 (kerjasama: M2 render panggil `renderTodoDigest()` dari store — interface sudah ada di M0; kalau kurang, TAMBAHKAN fungsi baru di modulmu, JANGAN edit M2).
- logReview.everyTurns (G-06): default 0 = mati; >0 → pada `agent/turn-stopping` antre nudge berlabel ke inbox sesi; penyampaian via `agent/pre-step` masuk `{kind:'enter'}` atau inbox M5 (pilih yang tersedia dari M0 NOTES; jangan daur ulang mekanisme).
- Acceptance: due-date sorting, overdue flagged, day rollover log, caps.

## M4 · Prompts domain
Write-set: `src/host/modules/prompts/**` + `test/prompts/**`
- Tools: cortex_prompt_list/get/save(→pending)/toggle/inject {id, mode once|sticky|clear, targetSession?}.
- State: `inject/<sessionId>.json`; render di jalur injeksi M2 yang sama (section terpisah `cortex:prompts`, header persis G-03, `once` decrement tiap turn — decrement hanya saat benar-benar dirender).
- sticky tanpa batas waktu = tidak boleh: `stickyMaxTurns` config default 25 → auto-clear + baris jujur "expired".
- Acceptance: once habis 1 turn; sticky hitung mundur; body > cap → potong + label; tidak pernah mengatasnamakan user.

## M5 · Rooms domain (kolaborasi multi-sesi)
Write-set: `src/host/modules/rooms/**`, `src/host/modules/sessions/**` + `test/rooms/**` (+ `src/client/modules/rooms/**` utk M7)
- Tools: cortex_room_create/list/join/post/read/status, cortex_session_spawn/send.
- Spawn: `typeof ctx.agents?.create === 'function'` feature-detect; meta.cwd = pemanggil bila tak diberi; model diwarisi dari agent pemanggil (agent.options) bila tak diberi; simpan sessionId→room mapping; kegagalan → pesan jujur + room tetap bisa join existing.
- Status: `ctx.agents.roots()` + `get(id).status` live; sesi mati/hilang → state 'gone'.
- Pesan: `agent.inject/followup/steer(HostUserMessage)` dengan `source:{kind:'plugin', plugin:'dsh-cortex'}` — JIKA terbukti host menolak/menampilkan tidak jujur (uji G-02 saat throwaway), fallback banner baris pertama: `[cortex room <id> · pesan dari sesi <label> via dsh-cortex plugin — bukan perintah user]`.
- Gambar: salin dari path lokal TERBATAS (harus ada di state root ATAU attachment dir host yang terbaca; tolak path acak user) ke `rooms/<id>/images/`; pesan injeksi menyebut path absolut + instruksi "use read_image".
- Inbox per sesi via M0 store; delivery saat pre-step/turn berikutnya, cap 5 pesan/turn + "N lebih" jujur.
- Acceptance: seq monoton, spawn-fallback teruji (mock ctx.agents tanpa create), delivery hanya ke anggota, gambar lintas-ruang tertolak.

## M6 · Delegation domain (eksternal CLI)
Write-set: `src/host/modules/delegate/**` + `test/delegate/**`
- Config: `delegation.enabled` default FALSE; runners = registry {name: {argv: string[], cwd?, timeoutSec?, outputCapBytes?}} — argv array, NO shell. Validasi: argv[0] ada di PATH dan match whitelist config; task/prompt masuk lewat ARGV template placeholder `{{taskFile}}` (tulis task ke file job, jangan tempel di argv panjang) — hindari arg injection.
- Tools: cortex_delegate (→ jobId segera; kalau off: pesan refusal jelas), cortex_delegate_status/logs/result, cortex_delegate_cancel.
- Jalankan: spawn via child_process argv-array + timeout + kill tree; tail log rotasi 2MB; selesai → result.md (cap) → write-back: log project+daily via store API (berlabel `machine-authored external output`), usulan memori ke pending, pesan room bila job ditautkan roomId.
- maxConcurrent enforced; job state di file (restart-safe; job yatim → status 'lost').
- Acceptance: echo-script runner (bash-safe fixture) e2e: dispatch→done→log muncul di daily+project→pending berisi usulan; enabled=false menolak; argv dari input user TIDAK PERNAH jadi command.

## M7 · Client UI
Write-set: `src/client/**` (kecuali file entry M0 — koordinasikan lewat append, jangan replace) + `test/client/**`
- Panel sesi di `conversation.view` (list slot, id 'cortex', order unik) + `settings.section` (order 30). Isi panel = tab-ringan: Memory, Todo, Pending, Rooms, Prompts, Jobs. Data via `ctx.connection.rpc.call('/dsh-cortex-read'|'/dsh-cortex-write', endpoint, payload)` — endpoint M2..M6 expose; DAFTAR endpoint final: tunggu `.dev/RPC-ENDPOINTS.md` (dipublish tiap agen modul begitu endpoint jadi; M7 mulai dari mock adapter).
- Komponen: React murni + ui-primitives; TANPA import lintas plugin (purity §9.5); type-only untuk SlotMap merges.
- Semua fetch dibungkus status handling (plugin host mati → kartu "cortex unavailable", bukan blank/crash).
- package.json `dsh.client.inject` kini = [connection, ui-slots] (placeholder M0). Saat M7 memakai `conversation.view` dan/atau `ctx.locale`, TAMBAHKAN paketnya ke daftar itu (`@deepseek-ai/dsh-client-ui-conversation`, `@deepseek-ai/dsh-client-locale`) — manifest itu bagian darimu, update searah.
- jsdom tests: mount + render snapshot dari fixture RPC; tombol approve/reject memanggil write channel dengan payload benar.

## M8 · Docs + README
Write-set: `README.md`, `docs/USAGE.md`, `.local-link.md` (di luar pkg, ikut konvensi induk)
- README: skenario per-feature (bahasa: EN utama + ringkas ID di header), install `link:` throwaway-tested, uninstall + purge + `rm -rf` baris, config defaults tabel (dari §7), BATASAN jujur (no self-evolution claims, G-05; residual risk G-07; delegation butuh runner config).
- Jangan klaim G-gates sebelum ada buktinya dari ledger verifikasi parent.

## M9 · Handoff Protocol (opsional, 2026-09-27)
Write-set: `src/host/modules/sessions/handoff.ts`, edit `spawn.ts`, `config.ts`, `types.ts`, `index.ts`, `test/sessions/handoff.spec.ts`
- **Tujuan**: saat `cortex_session_spawn`, otonomis tambahkan blok konteks terstruktur ke prompt agen baru agar ia mengetahui state yang sedang berjalan tanpa harus membaca transcript lengkap.
- **Format handoff** (4 section):
  - `### summary` — placeholder, diisi caller via prompt; handoff tidak mengarang ringkasan
  - `### what-changed` — baris log project+daily terakhir (2 hari), terbaru dulu
  - `### what-remains` — todo terbuka (maks 6 baris), urut sesuai `orderForDigest`
  - `### blockers` — teks opsional dari caller, atau `(none surfaced)`
- **Config gate**: `handoff.enabled` di `CortexConfig` (default `false`, opt-in).
- **Budget**: 2000 chars total (`HANDOFF_BUDGET_CHARS`); framing + header dihitung masuk budget.
- **Integrasi spawn**: di `spawn.ts`, sebelum `rooms.post` task, cek `cfg.handoff?.enabled === true` → collect + render + prepend ke `fullPrompt`. Kegagalan read → warn + prompt tetap dikirim tanpa handoff.
- **Test**: 11 unit test di `test/sessions/handoff.spec.ts` — struktur, budget, todo truncation, log error, blocker inclusion.
- **G-06**: block label jujur `[dsh-cortex · handoff]` di header paling atas.

## M10 · Decision Log (2026-09-27)
Write-set: `src/host/modules/decisions/**`, `test/decisions/**`, edit `store.ts`, `types.ts`, `index.ts`
- **Tujuan**: saat `cortex_log_append` menulis baris dengan tag `[decision]`, log di-parse jadi entri terstruktur di `$STATE_ROOT/decisions/<id>.json`.
- **Format log line**: `- [decision] <context> | options: <a, b> | chosen: <X> | rationale: <why>`
  - Semua section optional selain `context`; `options` max 8×120 char; `chosen` harus match options atau "none of above"; `rationale` ≤500 char.
- **Store methods** (ditambahkan di `store.ts`): `addDecision`, `listDecisions`, `getDecision` + path helpers `decisionDir`, `decisionPath`.
- **Tools**:
  - `cortex_decision_index_logs` — scan log N hari, parse baris `[decision]`, simpan JSON, auto-link ke memori
  - `cortex_decision_search` — cari decision by query + tag/pid filter, relevansi scoring, hasil sekaligus dirender
  - `cortex_decision_list` — daftar decision terbaru + id-nya (permukaan visual/cari id)
  - `cortex_decision_link` — tautkan id entri memori ke decision secara manual
- **Format log line** (fleksibel, 2026-09-27 diperluas):
  - `- [decision] <context> | options: <a, b> | chosen: <X> | rationale: <why>`
  - Alias field ID/EN: context/konteks/situasi, options/opsi/pilihan/alternatives, chosen/chose/selected/picked/dipilih/keputusan, rationale/reason/because/why/alasan/karena, owner/by/pemilik, tags/labels
  - Separator `|` atau `;`; nilai boleh mengandung `|` (scan mencari key berikutnya, bukan pemisah)
  - Markdown `**bold**` di key/nilai dibersihkan; `chosen` bebas teks bila options kosong; toleransi substring ≥2 char; keluarga "none" (`none`, `n/a`, `tidak ada`, `reject all`) selalu sah
- **Auto-link**: saat decision di-index, memori (user+global+project) dicari dengan kata context+chosen; max 5 id tersimpan di `linkedEntries` (LINK_MAX 12 total). Kegagalan baca memori = tanpa link, decision tetap tersimpan.
- **Store**: `addDecision`, `listDecisions`, `getDecision`, `updateDecision` (hanya field turunan: linkedEntries/tags/owner — field hasil parse tidak bisa diedit tangan supaya tidak menyimpang dari log).
- **Test**: 22 parser spec + 18 tool spec = 40 test.
- **Sisa limitasi jujur**: auto-link berbasis kesamaan kata, bukan semantik — keputusan yang kalimatnya tidak cocok teksnya tidak terlink (sarat `cortex_decision_link` manual); `timestamp` = waktu indexing, bukan waktu keputusan diambil; dedup memakai pasangan (context, chosen) sehingga dua keputusan berbeda dengan konteks identik akan dianggap satu.
