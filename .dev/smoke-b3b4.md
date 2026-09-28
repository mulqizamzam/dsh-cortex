# Smoke test pasca-restart — aktivasi B3/B4 (prompts module + by-kind approval)

Dibuat sebelum restart (sesi yang menyiapkan B3/B4). Sesi pasca-restart: jalankan
checklist ini apa adanya, jangan menambah probe eksploratif.

Konteks: bundle baru `lib/index.js` (mtime 2026-09-16 23:54:27 +0700,
sha256 `316e81ac…`) berisi modul prompts (5 tool + 6 endpoint). Host yang berjalan
sebelum restart memakai bundle lama: registry live-nya 29 tool `cortex_*` tanpa
satu pun tool prompt.

## Checklist

1. **Registry live berisi 5 tool prompt.**
   Bukti: daftar tool di sesi baru harus memuat
   `cortex_prompt_list`, `cortex_prompt_get`, `cortex_prompt_save`,
   `cortex_prompt_toggle`, `cortex_prompt_inject`.
   Harapan total: 29 + 5 = **34** tool `cortex_*`.

2. **`prompts.list` merespons.** Panggil `cortex_prompt_list {}` → `ok`, daftar
   (boleh kosong). Ini jalur modul → store yang sebenarnya.

3. **Mutasi prompt jalan (schema didukung).** `cortex_prompt_save {title, body}`
   → doc tersimpan; lalu `cortex_prompt_toggle {id, enabled:false}` → row mati.
   Catat id untuk langkah 5.

4. **Jalur approval mencapai `approved`.** `cortex_prompt_save` dari AI membuat
   baris `pending` (autoAccept default false). Approval sendiri hanya lewat kanal
   tulis `/dsh-cortex-write` (panel UI). Kalau tidak ada akses klik panel:
   - coba route loopback:
     `curl -s -X POST http://127.0.0.1:13080/dsh-cortex-write -H 'Host: 127.0.0.1:13080' ...`
     (kalau fence menolak dengan 403, catat sebagai keterbatasan alat, JANGAN
     diakali), atau
   - minta operator menyetujui satu baris dari panel.
   Bukti sukses: baris pending jadi `approved` dan prompt muncul di library.

5. **`prompts.enabled=false` → perilaku `disabled`.** Uji di root throwaway, bukan
   state pengguna:
   - set `prompts.enabled:false` pada state root sementara (atau lewat config
     layer kalau operator izinkan), lalu panggil `cortex_prompt_list` →
     harus menjawab `disabled` sesuai `.dev/RPC-ENDPOINTS.md:70-71`.
   - Kalau mengubah config berarti menyentuh state pengguna, **lewati** dan catat
     sebagai tidak diuji (jangan ubah state pengguna demi smoke test).

## Rollback kalau boot gagal

1. `cp .dev/rollback/index-pre-b3b4.js lib/index.js` (sha256 `c9c1d09d…` = bundle
   yang dibangun dari source anchor Phase 1, sebelum B3/B4).
2. Restart host lagi.
3. Source anchor tetap utuh:
   `tar xzf .dev/snapshots/phase1-anchor-20260916-221555/tree-pre-edit.tgz -C <root>`.

Catatan: kegagalan satu modul tidak mematikan boot (DESIGN P4) — kalau `prompts`
gagal, module itu berstatus `failed` dan `cortex_status` melaporkannya; sisanya
tetap jalan.
