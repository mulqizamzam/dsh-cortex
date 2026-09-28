# PRD: dsh-cortex — Cross-Session Memory & Collaboration Plugin

| | |
|---|---|
| **Nama plugin** | `dsh-cortex` |
| **Versi** | v0.1.0 |
| **Status** | Implementation Complete — VERIFIED FOR TESTED SCOPE |
| **Host minimum** | DeepSeek Harness v0.1.1-rc.1 |
| **Target profil** | `web` (GUI), headless-compatible |
| **Instalasi** | `link:` lokal, satu direktori state disposable |
| **Koeksistensi** | Jalan berdampingan dengan `dsh-mnemon` (nol tabrakan tool/slot) |

---

## 1. Ringkasan Eksekutif

**dsh-cortex** adalah plugin DeepSeek Harness yang memberikan **memori lintas-sesi, manajemen tugas, log proyek, kolaborasi multi-agen, pustaka prompt, dan delegasi eksternal** — semuanya dalam satu plugin murni tanpa modifikasi core.

Plugin ini dibangun sebagai **clean-room replacement** dari `dsh-memory-evolve` (verdict audit: **JANGAN PASANG**) dengan menelan semua temuan audit dan menerapkan 8 prinsip non-negotiable (P1–P9) yang menjamin keamanan, kejujuran injeksi, dan stabilitas boot.

### Value Proposition

| Masalah tanpa cortex | Solusi cortex |
|---|---|
| AI lupa konteks antar sesi | Memori persistent bertingkat (user/global/project) |
| Tugas tercecer di chat | Todo 4-track dengan due date & flag urgent |
| Tidak ada history keputusan | Project log + daily log append-only |
| Sub-agent kerja sendiri | Room multi-sesi dengan pesan real-time |
| Prompt berulang harus diketik ulang | Prompt library + one-click inject |
| Delegasi ke tool CLI manual | Async job dengan auto write-back ke log |

---

## 2. Latar Belakang & Motivasi

### 2.1 Masalah yang Diatasi

DeepSeek Harness adalah platform multi-agent yang menjalankan banyak sesi AI secara paralel. Masalah utama:

1. **Stateless per-sesi**: Setiap sesi baru dimulai tanpa konteks dari sesi sebelumnya.
2. **Tidak ada manajemen tugas terstruktur**: Agent tracking dilakukan via chat, mudah hilang.
3. **Tidak ada kolaborasi terstruktur**: Agent tidak bisa berkomunikasi secara terorganisir.
4. **Prompt repetitif**: Workflow berulang harus ditulis ulang setiap sesi.

### 2.2 Mengapa Clean-Room?

Plugin sejenis (`dsh-memory-evolve`) telah diaudit dan ditemukan memiliki **4缺陷 fatal**:

| Defect | Dampak | Status di cortex |
|---|---|---|
| Keamanan: handler mutasi tanpa auth guard | POST lintas-asal bisa aktifkan fitur berbahaya | ✅ Nol handler tanpa guard; loopback RPC only |
| Kebohongan: injected memory disamarkan jadi user指令 | Model mengeksekusi "perintah" yang sebenarnya data plugin | ✅ Label jujur di setiap injeksi |
| Data: character cap dihapus, injeksi tak terbatas | Context window overflow, model confusion | ✅ Hard caps ditegakkan dua sisi (write + render) |
| Boot fragility: file korup = GUI mati | Plugin bisa mematikan whole DSH | ✅ Quarantine + degraded mode |

Cortex dibangun dari nol dengan checklist audit sebagai acceptance criteria.

---

## 3. User Stories

### 3.1 Memori Lintas-Sesi

**US-01: Simpan Fakta Penting**
> Sebagai operator, saya ingin mengatakan "catat: deploy port 8080" dan AI akan menyimpannya sebagai proposal yang saya approve sekali, sehingga semua sesi berikutnya akan melihat fakta itu.

- AI proposing entry → masuk `pending/` queue
- User approve via UI (Cortex panel) → entry aktif
- Setiap turn berikutnya: injeksi blok `[dsh-cortex · plugin memory]` berlabel jujur
- Track: `user` (profil), `global` (fakta universal), `project` (spesifik repo)

**US-02: Branch-Scoped Memory**
> Sebagai developer, saya ingin memori tertentu hanya aktif saat di branch `main`, tidak saat di `dev`.

- Entry memori punya field `branches: ["main"]`
- Render injeksi mem-filter berdasarkan `git branch --show-current`
- Entry tanpa `branches` = global (selalu inject)

**US-03: Arsip & Pencarian**
> Sebagai operator, saya ingin mengarsipkan memori lama tapi tetap bisa mencarinya nanti.

- `cortex_memory_archive {id}`: entry pindah ke archive, berhenti inject
- `cortex_memory_search {query}`: substring + token matching, hasil snippet ter-cap
- Archive tetap readable via search

### 3.2 Manajemen Tugas

**US-04: Todo 4-Track**
> Sebagai project manager, saya ingin menandai tugas dengan prioritas dan deadline.

- Tracks: `life`, `work`, `project`, `daily`
- Flags: `important` (ranking dalam track), `urgent` (ranking across tracks)
- Due date: `YYYY-MM-DD` format, wajib legal
- Digest injeksi otomatis ke konteks per-turn

**US-05: Progress Reporting**
> Sebagai lead, saya ingin laporan ringkas apa yang sudah dikerjakan hari ini.

- `cortex_progress_report`: sintesis open todos + N entri project terbaru + tail log hari ini
- Format: cap 4000 chars, section title + preview

### 3.3 Kolaborasi Multi-Sesi

**US-06: Buat Ruangan Kolaborasi**
> Sebagai orchestrator, saya ingin membuat ruangan dan spawn sub-agent untuk front-end dan QA secara paralel.

- `cortex_room_create {title}` → room ID
- `cortex_session_spawn {room, label, prompt}` → buat sesi baru, enroll ke room
- `cortex_room_post {roomId, text, images?}` → kirim pesan + gambar
- `cortex_room_status {roomId}` → lihat status anggota (running/idle/gone)
- Gambar: cap 8MB/file, tipe whitelist (PNG/JPEG/WebP/GIF)

**US-07: Pesan Real-Time**
> Sebagai anggota room, saya ingin mendapat notifikasi saat ada pesan baru.

- Notifikasi injeksi ringkas di awal turn anggota yang idle
- Wake idle members via `cortex_session_send`
- Sequence number monotonic untuk ordering

### 3.4 Delegasi Eksternal

**US-08: Delegasi ke Runner CLI**
> Sebagai orchestrator, saya ingin mendelegasikan tugas ke runner eksternal (mis. Python script) dan otomatis menulis hasilnya ke log.

- `cortex_delegate {runner, task, workdir?, images?, includeMemory?}`
- Runner dikonfigurasi via config `delegation.runners.<name>.argv[]`
- Async: job berjalan background, logs di-stream
- Auto write-back: `result.md` → `cortex_log_append` (project + daily) + memory proposal
- Label: semua output berlabel `machine-authored`

### 3.5 Prompt Library

**US-09: Simpan & Injeksi Workflow**
> Sebagai developer, saya ingin menyimpan checklist review code dan injeksi ke sesi lain.

- `cortex_prompt_save {title, body, category?}` → pending approval
- `cortex_prompt_list {}` → daftar prompt
- `cortex_prompt_inject {mode, promptId}` → once/sticky/clear
- Honest headers: `## Saved workflow: <nama> (dsh-cortex prompt library — injected on request, <N> rounds left)`

---

## 4. Spesifikasi Teknis

### 4.1 Arsitektur

```
┌─────────────────────────────────────────────────────────────┐
│                    DeepSeek Harness Host                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Session   │  │   Session   │  │   Session (You)     │ │
│  │    Agent    │  │    Agent    │  │      Agent          │ │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────────┘ │
│         │                │                   │              │
│  ┌──────▼────────────────▼───────────────────▼────────────┐ │
│  │              System Prompt Assembly                     │ │
│  │  (inject blocks from cortex with honest labels)         │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │              cortex_ Tools (35 tools)                   │ │
│  │  memory · todo · logs · prompts · rooms · delegate      │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │              CortexStore (state management)             │ │
│  │  atomic write · quarantine · caps enforcement           │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │              State Root: $DSH_HOME/dsh-cortex/           │ │
│  │  schema.json · projects/ · user/ · global/ · todos/     │ │
│  │  prompts/ · rooms/ · delegation/ · pending/ · tmp/      │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ RPC (loopback-fenced)
                            │
                 ┌──────────┴──────────┐
                 │  Client UI Panel   │
                 │  (React, session   │
                 │   tab "Cortex")    │
                 └───────────────────┘
```

### 4.2 State Root Layout

```
$DSH_HOME/dsh-cortex/
├── schema.json              # { version: 1 } — read-tolerant
├── projects/<pid>/
│   ├── meta.json            # { pid, remoteUrl?, cwdHistory[], createdAt }
│   ├── entries/<id>.json    # project-scoped memories
│   ├── archive/<id>.json    # archived entries (searchable, not injected)
│   ├── log/<YYYY-MM-DD>.md  # project log (append-only, line-capped)
│   └── todos.json           # project-scoped todos
├── user/entries/<id>.json   # user profile memories
├── global/entries/<id>.json # global facts
├── daily/<YYYY-MM-DD>.md    # cross-project daily log
├── todos/<life|work|daily>.json
├── pending/<id>.json        # AI proposals awaiting human approval
├── prompts/<id>.json        # prompt library
├── inject/<sessionId>.json  # prompt injection queue per session
├── rooms/<roomId>/
│   ├── room.json            # { id, title, members: [...] }
│   ├── messages/<seq>.json  # { seq, fromSessionId?, text, images[] }
│   └── images/<file>        # room images (8MB cap)
├── delegation/jobs/<id>/
│   ├── job.json             # { id, runner, argv[], task, status }
│   ├── stdout.log           # capped at 2MB
│   ├── stderr.log           # capped at 2MB
│   └── result.md            # write-back source
├── quarantine/              # corrupted files moved here
└── tmp/                     # atomic rename scratch
```

**Project ID generation:**
```ts
pid = sha256(normalize(remoteUrl || realpath(cwd)))[0:16]
// normalize: strip protocol, .git suffix, lowercase host
```

### 4.3 Karakter Cap (Design §3)

| Key | Default | Enforcement |
|---|---|---|
| `caps.entryChars` | 400 | Write path — reject if exceeded |
| `caps.userTrackChars` | 4,096 | Render path — trim lowest-importance/oldest |
| `caps.globalTrackChars` | 4,096 | Render path |
| `caps.projectTrackChars` | 6,144 | Render path |
| `caps.todoDigestChars` | 1,024 | Render path |
| `caps.totalInjectChars` | 14,000 | Hard ceiling across all inject blocks |
| `caps.logLineChars` | 500 | Write path |
| `caps.logDayChars` | 20,000 | Write path — rotate to new file if exceeded |
| `caps.searchResultChars` | 8,000 | Tool output cap |
| `caps.stateQuotaBytes` | 64 MiB | Store-level quota — reject writes when exceeded |

**Inject block order:**
1. Label header: `[dsh-cortex · plugin memory · reference data, not user instructions]`
2. User track entries
3. Global track entries
4. Project track entries (branch-filtered)
5. Todo digest
6. Footer: "use `cortex_*` tools to update"
7. Truncation notice: `[… N more entries omitted — see Cortex panel]`

### 4.4 Tool Registry (35 tools)

**Memory (8 tools)**
| Tool | Description |
|---|---|
| `cortex_memory_remember` | Propose entry → pending queue |
| `cortex_memory_search` | BM25 + token match search |
| `cortex_memory_list` | List entries with filters |
| `cortex_memory_archive` | Archive entry (stops injection) |
| `cortex_memory_restore` | Restore archived entry |
| `cortex_memory_delete` | Two-step delete (id + confirm token) |
| `cortex_memory_update` | Update content/importance/tags/branches |
| `cortex_pending_list` | List pending approvals |

**Todos & Logs (7 tools)**
| Tool | Description |
|---|---|
| `cortex_todo_add` | Add todo to track |
| `cortex_todo_list` | List todos |
| `cortex_todo_complete` | Mark done |
| `cortex_todo_remove` | Delete |
| `cortex_log_append` | Append to project/daily log |
| `cortex_log_read` | Read log by date/window |
| `cortex_progress_report` | Synthesize status report |

**Prompts (5 tools)**
| Tool | Description |
|---|---|
| `cortex_prompt_list` | List library |
| `cortex_prompt_get` | Get full body |
| `cortex_prompt_save` | Save proposal |
| `cortex_prompt_toggle` | Enable/disable |
| `cortex_prompt_inject` | Inject to session |

**Rooms (7 tools)**
| Tool | Description |
|---|---|
| `cortex_room_create` | Create room |
| `cortex_room_list` | List rooms |
| `cortex_room_join` | Join room |
| `cortex_room_post` | Send message + images |
| `cortex_room_read` | Read transcript |
| `cortex_room_status` | Live member status |
| `cortex_session_spawn` | Spawn new session to room |
| `cortex_session_send` | Send to session |

**Delegation (4 tools)**
| Tool | Description |
|---|---|
| `cortex_delegate` | Submit async job |
| `cortex_delegate_status` | Check job status |
| `cortex_delegate_logs` | Tail logs |
| `cortex_delegate_result` | Get result.md |

**Admin (2 tools)**
| Tool | Description |
|---|---|
| `cortex_pending_reject` | Reject proposal |
| `cortex_purge` | Delete all state (requires exact confirm string) |
| `cortex_status` | Health report |

### 4.5 Transport & Security

**RPC Channels (2 channels, loopback only)**
```
POST /rpc → connection.rpc.handle('/dsh-cortex-read', handler, { authority: 'loopback' })
POST /rpc → connection.rpc.handle('/dsh-cortex-write', handler, { authority: 'loopback' })
```

**Security boundaries:**
- **No webServer routes**: Zero HTTP handlers exposed via `webServer.register()`
- **Loopback authority**: Only processes on same host can reach handlers
- **Capability tokens**: Write endpoints require UI-issued tokens per session
- **Confirm strings**: Destructive ops (`cortex_purge`) require exact string match
- **No cross-origin**: 127.0.0.1 bind only, no Origin header bypass

### 4.6 Config Schema

```yaml
- id: dsh-cortex
  config:
    stateRoot: ''                    # '' = $DSH_HOME/dsh-cortex; absolute path relocates
    inject:
      enabled: true                  # Master toggle
      user: true                     # Inject user track
      global: true                   # Inject global track
      project: true                  # Inject project track
      todo: true                     # Inject todo digest
    memory:
      autoAccept: false              # AI proposes, human approves (P3 safe default)
    rooms:
      enabled: true
    prompts:
      enabled: true
    delegation:
      enabled: false                 # OFF by default (P3)
      runners:
        hermes:
          argv: ["hermes", "run", "--task-file", "{{taskFile}}"]
          description: "Hermes AI runner"
          timeoutSec: 3600
          env: {}
      maxConcurrent: 2
      jobTimeoutSec: 3600
      outputCapBytes: 1048576        # 1MB per job log
    caps:                            # Override individual caps
      entryChars: 400
      totalInjectChars: 14000
      # ... all caps
    retention:
      dailyLogDays: 90               # Rotate daily logs after N days
    logReview:
      everyTurns: 0                  # 0 = off; >0 = inject reminder every N turns
```

**⚠️ Patch rule**: Config patch row **REPLACES** entire config value (no deep merge). Restate all keys in examples.

---

## 5. Non-Goals (v1)

| Scope | Reason |
|---|---|
| Unlimited canvas | Out of scope for memory plugin |
| Git sync across machines | Would require external service |
| Advisor/reviewer per session | Complex ranking logic, defer to P2 |
| Bookmark injector (DOM hacking) | Fragile, security risk |
| IM notification channel | Telegram plugin exists |
| Semantic search (embeddings) | Requires ML backend, deferred |
| Self-evolution/reinforcement | No-op pattern from audit; ranking = importance + createdAt |
| Cross-plugin SKILL.md writing | Absolute prohibition (P5) |

---

## 6. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Test coverage | ≥90% | `vitest run` → green suite |
| Boot resilience | 0 crashes on corrupt data | G3 e2e: 1-byte corruption → quarantine, host alive |
| Install cleanliness | Zero profile delta except `link:` dep | G5: `diff -r` after remove = empty |
| Tool collision | 0 overlaps with `dsh-mnemon` | G13: 35 `cortex_*` vs 15 `mnemon_*`, disjoint |
| Honest injection | 100% blocks labeled | G9: grep `dsh-cortex` prefix in all renderers |
| Brace safety | 0 unescaped `{{`/`}}` in output | G14: neutralize() on all renderer paths |
| Quota enforcement | Reject over-quota writes with clear error | G16: unit test quota refusal |
| GUI verification | OPERATOR-VERIFIED | G12: interactive checklist PASS |

---

## 7. Gate Verification Status

| Gate | Description | Status | Evidence |
|---|---|---|---|
| G1 | Unit tests | ✅ 493/494 passed | `pnpm test` exit 0 |
| G2 | Build + typecheck | ✅ Clean | `tsc --noEmit` + `pnpm build` |
| G3 | Boot resilience | ✅ Passed | Corrupt 1-byte → quarantine, host alive |
| G4 | Isolated install | ✅ Passed | Throwaway DSH_HOME, tools register |
| G5 | Uninstall clean | ✅ Passed | Profile delta = 0 after remove |
| G6 | Constraint sweep | ✅ Passed | All C-xx checked |
| G7 | Security surface | ✅ Passed | Zero webServer routes, loopback RPC |
| G8 | Injection caps | ✅ Passed | Output ≤ caps, truncation works |
| G9 | Honest labels | ✅ Passed | All inject blocks labeled |
| G10 | Room e2e | ✅ Passed | Throwaway headless: spawn + post + response |
| G11 | Delegation e2e | ✅ Passed | Echo-script adapter: job → result → write-back |
| G12 | UI smoke | ✅ OPERATOR-VERIFIED | Interactive checklist PASS |
| G13 | Coexistence | ✅ Passed | 35 cortex_* vs 15 mnemon_*, zero overlap |
| G14 | Brace safety | ✅ Passed | neutralize() on all renderer paths |
| G15 | Config-save integrity | ✅ Unit-covered | Read-modify-write + revision check |
| G16 | Quota enforcement | ✅ Passed | Reject over-quota, quarantine corrupt |

**Overall**: VERIFIED FOR TESTED SCOPE (per operator directive 2026-09-16)

**Known limitations**:
- G11: Hermes env-blocked in sandbox; validated via echo-script adapter
- G15: Unit-covered only, not re-run live

---

## 8. Installation & Uninstall

### Install
```sh
cd /home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex
pnpm install && pnpm run build       # lib/ must exist before boot
dsh --profile web plugin add link:"$(pwd)"
# Verify:
dsh --profile web --dump-config | grep dsh-cortex
```

### Uninstall
```sh
dsh --profile web plugin remove dsh-cortex
rm -rf "$DSH_HOME/dsh-cortex"        # Optional: purge state
```

**Note**: `dsh plugin remove` preserves state data (reinstall can reuse). Use `cortex_purge` or manual delete to reclaim space.

---

## 9. Module Breakdown (Implementation)

| Module | Path | Responsibility | Dependencies |
|---|---|---|---|
| M0 | `src/host/index.ts`, `src/lib/*.ts` | Entry point, primitives (ids, caps, fsx, sanitize) | None |
| M1 | `src/host/store.ts` | Domain store (entries, todos, logs, pending, prompts, quarantine) | M0 |
| M2 | `src/host/modules/memory/` | Tracks, archive, search, inject renderer, branch filter | M1 |
| M3 | `src/host/modules/{todo,logs,progress}/` | Todo 4-track, log append/read, progress report | M1 |
| M4 | `src/host/modules/prompts/` | CRUD, inject queue, render to context | M1 |
| M5 | `src/host/modules/rooms/` | Session spawn/send/status, messages, images | M1, M0 |
| M6 | `src/host/modules/delegate/` | Runner registry, spawn argv, write-back | M1 |
| M7 | `src/client/` | React panel, RPC client, settings | M0 |
| M8 | `test/`, `docs/` | Unit tests (tmp HOME isolation), integration, docs | All |

**Wiring order**: M0+M1 → M2–M6 (parallel) → M7 (parallel after mock) → M8 (continuous)

---

## 10. Open Questions (Resolved)

| ID | Question | Resolution |
|---|---|---|
| OQ-1 | Can plugins register tools? | ✅ Yes: `ctx.tools.register(defineTool(...))` |
| OQ-2 | Transport mechanism? | ✅ Loopback RPC via `connection.rpc.handle()` |
| OQ-3 | Context injection seams? | ✅ `systemPrompt.context()` + `system-prompt/assemble` + `agent/pre-step` |
| OQ-4 | Session spawn API? | ✅ `ctx.agents.create` (feature-detect, optional) |
| OQ-5 | Client slot IDs? | ✅ Verified: `conversation.view`, `settings.section` |
| OQ-6 | Uninstall data cleanup? | ✅ Data preserved; `cortex_purge` + `rm -rf` documented |

---

## 11. File References

| File | Purpose |
|---|---|
| `DESIGN.md` | Design contract, non-negotiable principles, module breakdown |
| `README.md` | User-facing documentation |
| `docs/HOST-API.md` | Host API ground truth (verified on rc.2) |
| `docs/TEST-PLAN.md` | Gate verification plan with evidence |
| `cordis.patch.yml` | Bundle patch for client injection |
| `package.json` | Dependencies, build scripts, DSH manifest |

---

*PRD generated from plugin source, DESIGN.md, HOST-API.md, and TEST-PLAN.md — 2026-09-20*
