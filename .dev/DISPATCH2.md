# DISPATCH 2 — gelombang-2 (dikirim SETELAH wave-1 settle; parent pegang shared files)

KONDISI: src/** wave-1 hijau + snapshot tar terbaru + peta nama final ada di
.dev/parent-groundtruth.md §HASIL SWEEP. Layout POST-incident = final:
helper tools di `src/host/dsh.ts`, tipe host di `dsh-internal.ts`, config satu file
`src/host/config.ts`, state root `resolveStateRoot` (lib/home). RPC read terpasang
via `registerCortexReadRpc`; write channel DIPEGANG PARENT (jangan mount sendiri).

---
## M4 · prompts (kirim via send_message ke subagent baru — cto, background)
Baca: DESIGN §4 (prompts) + §9.1 G-03 ruling; docs/HOST-API.md §3 (context seam
'cortex:prompts' order 43) + §10; .dev/BRIEFS.md §M4; .dev/RPC-ENDPOINTS.md
prompts.*/inject.*; kode wave-1 sebagai CONTOH POLA (pilih src/host/modules/memory
— baca file aslinya di disk, JANGAN hapal); src/host/modules/status sebagai template modul.
Write-set: src/host/modules/prompts/** + test/prompts/**.
DELIVER: CRUD PromptDoc via store (addPrompt/updatePrompt/deletePrompt/listPrompts);
tools cortex_prompt_list/get/save(->addPending kind 'prompt')/toggle/inject
{promptId|text, mode once|sticky|clear, targetSession? -> validasi target lewat
ctx.agents.get(id) atau store room member; sesi tak dikenal = refusal};
context('cortex:prompts') render: label G-03 persis + rounds-left counter (once=1,
sticky default 25 konstan modul, auto-clear + baris 'expired' jujur), decrement
HANYA saat benar-benar dirender (buktikan di test dgn render 2x); body lewat
neutralize + caps 2000 char/kali-render; endpoint maps readEndpoints/writeEndpoints
untuk prompts.list/get + prompts.save/toggle/delete + inject.now (delete confirm
'DELETE'). includeMemory utk M6 TIDAK di sini — M6 panggil store langsung.
TESTS: once-keluar setelah 1 render; sticky decrement + expiry line; no-agent ctx
contrib ''; label prefix di semua jalur; save->pending->(helper approve manual di
test)->prompt file; caps. Green own-tests + tsc on own files.

## M7 · client UI (subagent baru — cto, background)
Baca: DESIGN §5; docs/HOST-API.md §9 + §9.5 + §10 (purity rules!); .dev/BRIEFS.md §M7
(+ baris inject-manifest); .dev/RPC-ENDPOINTS.md (kontrak endpoint — mock-nya);
src/host/rpc-channels.ts; file klien M0 sebagai titik ganti (WRITE-SET termasuk
mengganti src/client/index.ts penuh + menambah src/client/**; tsdown.config target
client SUDAH BENAR lazy-CJS — JANGAN sentuh; kalau butuh dependensi (react types)
tambah devDeps + `pnpm install` boleh, TAPI jangan ubah scripts).
DELIVER: panel tab sesi (slot 'conversation.view') + kartu settings (slot
'settings.section', id 'cortex', order 30) sebagai satu bundle klien; React
defineComponent, type-only imports utk merges, tanpa value-import lintas paket;
subview: Memory | Todo | Pending | Rooms | Prompts | Jobs | Settings-config
(form render dari ping().configSnapshot, save = whole-object read-modify-write +
revision, gerbang G15); RPC via ctx.connection.rpc.call dengan loading/error state
(jangan blank-crash); approve/reject pending buttons; room image = link path (bukan
upload); form jobs cuma lihat + cancel; TOMBOL spawn room cuma muncul bila
ping().modules mengabarkan sessions-capable. jsdom mount test + fixture RPC
(test/client/**). Hapus src/client/react.d.ts bila pindah peer react/@types/react.
Green own-tests + tsc own files. JANGAN jalankan build penuh paket (parent yang
rebuild saat integrasi) — TS-only checks.
---
URUTAN: M4 dulu (butuh pola wave-1), M7 paralel boleh. Setelah keduanya settle:
parent integrasi (MODULES array, write-channel mount, config additions), lalu
verifikasi chain G1-G2 + snapshot + G3/G4 boot harness + R1-integrasi + M8 docs pass.

## R2 · INTEGRATION REVIEWER (kirim SETELAH integrasi wave-1 + rebuild, paralel dgn M4/M7)
Kirim sebagai subagent_cto baru. Scope sempit, artefak tunggal `.dev/REVIEW-R2.md`
(skeleton-first, incremental). Input: kode jadi src/** + test/** + lib/index.js hasil build.
Tugas (hanya BACA + jalankan tes yang sudah ada; satu-satunya tulis = file review):
1. G6 sweep: setiap C-xx §2 RECON-SCENARIOS yang relevan v1 → {PASS|FAIL|N-A|PARTIAL} dengan
   sitasi file:line NYATA (buka tiap file; jangan percaya daftar ini) + alat bukti (nama tes).
2. G7: grep `webServer`/`http.createServer`/`listen(` di src+lib = 0; kedua kanal = authority
   loopback; handler unknown-endpoint tidak pernah throw; konfirmasi destruktif string persis.
3. G9/G14: SEMUA jalur render (memory/todo/rooms mails/prompts/delegate result+argv view/
   status/pending list) label jujur + bebas pasangan kurung — tes manual dengan string hostil
   via node -e terhadap dist (bukan cuma percaya unit test); cek `Job.argv` dg '{{taskFile}}'
   TIDAK pernah muncul mentah di output tool.
4. Routing pending.approve by-kind: tes tiga kind lewat dispatcher (bukan cuma memory).
5. Sanity arsitektur: modul tak saling import; tidak ada tulis di luar state root (grep write
   path); MODULES loop terisolasi try/catch; apply() tak bisa throw; cache injector invalid
   on write; orphan jobs; cap LIST_CAP jujur.
6. Output: tabel + TOP-N MUST-FIX dengan rekomendasi patch kecil; confidence per bagian;
   sitasi usang = FAIL-CITATION. Batas waktu: berhenti saat konvergen, jangan cari sempurnaan.
