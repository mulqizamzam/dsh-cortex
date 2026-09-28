# FAN-OUT DISPATCH — template siap-kirim (isi [BRACKETS] otomatis dari BRIEFS)

KONDISI AKSI: sanitize.ts ada + M0 laporan final + parent recheck hijau.
Semua agen: subagent_cto, background, write-set DISJOINT (path di bawah), larangan
menyentuh file agen lain, JANGAN jalankan `vitest run` paket penuh (polusi window
sibling — jalankan HANYA tes file sendiri: `./node_modules/.bin/vitest run test/<dir>`).
ATURAN INTEGRASI (anti-race, revisi ronde 13): modul TIDAK PERNAH menyunting
src/host/index.ts / config-schema.ts / types.ts / store.ts (shared-file, penulis
tunggu = parent). Masing-masing mengekspor `{name, TOOLS, apply}` dari direktorinya;
parent menggabungkan entri MODULES + field config tambahan SATU KALI saat integrasi.
Untuk tes sendiri: bangun deps manual lewat test/helpers.ts (bukan via index).

---
## M2 (memory)
prompt = BRIEFS §M2 + konteks wajib:
- Baca: DESIGN.md §2/§3/§4, docs/HOST-API.md §3 (seam = systemPrompt.context, cast ctx
  sebagai {agent?}), .dev/BRIEFS.md blok M2 + UPDATE ronde-12 (pola modul & TOOLS),
  .dev/RPC-ENDPOINTS.md, contoh implementasi: src/host/modules/status/index.ts,
  src/host/tools.ts (defineTool/registerToolSafe), src/host/store.ts API.
- Write-set: src/host/modules/memory/** + test/memory/**. Ekspor {name,TOOLS,apply};
  pengaitan MODULES oleh parent saat integrasi (JANGAN sentuh src/host/index.ts).
- Definition of done: vitest run test/memory hijau; tiap jalur render lewat
  neutralize + label; 500-entri budget test; search capped; pending-gate (autoAccept
  false default); branch filter; arsip.

## M3 (todo + logs + progress)
BRIEFS §M3. Write-set: src/host/modules/{todo,logs,progress}/** + test/tasks/**. Sewa helper renderTodoDigest utk blok M2 (export dari
modul todo; M2 TIDAK meng-import modul-mu — parent yang sambungkan nanti via deps
kalau perlu; v1 boleh digest dirender modul todo SENDIRI lewat context terpisah
'cortex:todo'). Keputusan parent: context terpisah (hindari kopling M2↔M3).
logReview nudge: pakai seam inbox store + pre-step; jangan sentuh modul lain.

## M4 (prompts)
BRIEFS §M4. Write-set: src/host/modules/prompts/** + test/prompts/**.
context name 'cortex:prompts'. stickyMaxTurns default 25 (tambah field config via
caps? TIDAK — config baru 'prompts.stickyMaxTurns' di config-schema.ts + types.ts (shared):
jangan edit — hardcode const modul + laporkan ke parent utk dipromosikan ke config). inject endpoint RPC write per contract.

## M5 (rooms+sessions)
BRIEFS §M5 + ruling G-02 (source plugin, fallback banner) + wake disposition +
feature-detect agents.create (uji runtime; refusal jujur). Write-set: src/host/modules/{rooms,sessions}/** + test/rooms/**.
ctx.agents.roots() utk status; images: salin HANYA dari dalam state root ATAU
dir attachment host yang terbaca-umum (whitelist prefix; tolak lainnya).

## M6 (delegation)
BRIEFS §M6. Write-set: src/host/modules/delegate/** + test/delegate/**.
Registry runner dari config (argv array P7); echo-runner fixture bash utk tes;
write-back via store API (label machine-authored + pending usulan memori).
maxConcurrent + timeout + rotation 2MB + restart-orphan 'lost'.

## M7 (client UI)
BRIEFS §M7. Write-set: src/client/** (entry M0 boleh digabung: index.ts sudah ada —
REPLACE isi, boleh, M0 sudah settle) + test/client/**. Mock adapter per
RPC-ENDPOINTS; komponen react-jsx + type-only dsh-client merges; purity §9.5;
jsdom mount test. Panel = satu tab conversation.view + settings.section real form
dari schema config (bukan hardcode field — render dari ping.configSnapshot + peta
kontrol kecil; simpan = whole-object + revision, G15).

## Reviewer R1 (read-only, jalan bersamaan dengan M2..M6)
Sweep G6 (C-01..C-40 x kode), G7 (grep dist: zero webServer), G9 (label jujur di
semua jalur), G14 (brace grep), lapor tabel PASS/FAIL per constraint dgn sitasi.
Write-set: HANYA .dev/REVIEW-R1.md.
---
URUTAN KIRIM: gelombang 1 = M2,M3,M5,M6,R1 (saling lepas). M4,M7 menyusul setelah
gelombang 1 settle (shared-file MODULES array & config-schema contention rendah
tapi nyata; parent yang gabungkan baris MODULES kalau race).
