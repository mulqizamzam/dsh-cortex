# dsh-cortex

Cross-session memory, 4-track todos, project logs, multi-session rooms, a prompt
library, and guarded external-CLI delegation for DeepSeek Harness — as one pure
plugin. No core modifications, one disposable state directory.

> **Status: v0.1.0 — implementation complete.** Build clean, full suite green
> (493 passed / 1 skipped, 32 files), all unit/security gates (G1–G9, G14, G16) and
> the isolated-install + uninstall + boot-resilience e2e (G3/G4/G4b/G5/G7) verified on
> a throwaway `DSH_HOME` (2026-09-15). Live install into the **active** web profile is
> NOT done — it needs an explicit operator GO (HIGH-risk; see `.local-link.md` §6).

## What it does

| Area | You say | dsh-cortex does |
|------|---------|-----------------|
| Memory | "记一下 / catat: deploy port 8080" | proposes an entry → you approve once → every later session sees it (labelled as plugin memory, never as your words) |
| Project / branch scoping | work in repo A, switch branches | entries carry structured `branches:[…]`; only matching-branch entries are injected |
| Archive + search | "arsipkan yang lama", "cari memori soal X" | archived entries stop injecting but stay searchable |
| Todos | "prioritas: kirim file DRF Jumat"; 4 tracks (life/work/project/daily) | stored per track; due/urgent flags; digest injected |
| Progress | "kemarin kita sampai mana?" | per-project + daily logs, `cortex_progress_report` |
| Rooms | "buat ruangan, spawn 2 sub-sesi buat front-end & QA" | real DSH sessions join a room, exchange messages (incl. images via `read_image`), status live, wake idle members |
| Delegation | "serahkan redesign ke runner X" *(off by default)* | async CLI job, logs streamed, summary auto-written back to project/daily logs + memory proposal, all labelled machine-authored |
| Prompts | "simpan workflow review ini", "injeksi kode-review checklist ke sesi itu" | prompt library; inject once/sticky with honest headers |

Tracks (memory): **user profile · global facts · project facts** (+ project log · daily log).

## Install (verified gate G4b on dsh 0.1.1-rc.2, throwaway-profile test)

```sh
cd <this package>
pnpm install && pnpm run build          # lib/ must exist before the host boots it
dsh --profile web plugin add link:"$PWD"  # writes dep row + reconciles bundles (verified)
# restart dsh web; then confirm composition:
dsh --profile web --dump-config | grep -A3 dsh-cortex
```

Belt-and-braces after add: verify `dsh.profile.bundles` contains `dsh-cortex`
(auto-reconciled on rc.2; older field notes claim otherwise — the shipped
reconciler wins, verified 2026-09-15).

## Uninstall

```sh
dsh --profile web plugin remove dsh-cortex
rm -rf "$DSH_HOME/dsh-cortex"            # the one disposable state directory
```

Verified (gate G5): removal leaves zero profile-side deltas; the only leftover is
`$DSH_HOME/dsh-cortex/` (data is KEPT on removal so reinstall can reuse it — delete
it yourself, or use `cortex_purge` from any session, to reclaim space). "Clean"
here means exactly that, no more.

## Configuration

Defaults are shipped-safe (heavy effects OFF): injection ON with hard caps;
`memory.autoAccept=false` (AI proposes, you approve);
`delegation.enabled=false` with an empty runner registry; `rooms.enabled=true`.

Override **by row id** in your profile's `cordis.patch.yml`. Patch rows REPLACE the
whole `config:` value (no deep merge) — restate every key you care about:

```yaml
- id: dsh-cortex
  config:
    stateRoot: ''            # '' = <DSH_HOME>/dsh-cortex (host home path); an ABSOLUTE path relocates all plugin data — a plain field, never a !!js expression
    inject:   { enabled: true, user: true, global: true, project: true, todo: true }
    caps:     { entryChars: 400, totalInjectChars: 14000 }   # full table: DESIGN.md §3
    rooms:    { enabled: true }
    delegation:
      enabled: true          # only if you configure runners
      runners:
        hermes: { argv: ["hermes", "run", "--task-file", "{{taskFile}}"] }  # argv array, never a shell string
```

Kill-switch without uninstall: `- id: dsh-cortex` `disabled: true` (also stops the
client bundle; verified mechanism).

## UI

Session tab **Cortex** (memory browser + archive/search, todo board, pending
approvals, rooms with live member status + images, prompt library, delegation
jobs) and a Settings section. `[VERIFY-BEFORE-RELEASE: gates G12 (jsdom) + operator
checklist after a real restart]`

## Honest limits (read this before trusting anything)

- Injected text is **reference data, not instructions from you** — every block is
  labelled; memory search is substring/token scoring, not embeddings.
- The AI never auto-approves its own proposals; proposals await a human
  decision in the Cortex panel (memory proposals become entries only through the
  approve action).
- Delegation output is untrusted external text: always labelled machine-authored;
  runners are argv arrays you configured; task text never becomes a command.
- No self-evolving/reinforcement magic: ranking = importance + recency (the audit
  of the plugin that *advertised* this proved it was a no-op — we won't repeat it).
- Sub-session spawn needs the host agent factory; where unavailable the tool refuses
  and rooms still work by joining existing sessions.
- Any process running as you can read the state dir (it is your home). No HTTP
  surface exists to attack — client UI talks over the host's loopback-fenced RPC
  channels only. `[G7]`

## For agents / docs

`DESIGN.md` (product contract, constraints P1–P9), `docs/HOST-API.md` (verified host
API notes incl. crash-traps), `docs/TEST-PLAN.md` (G1–G16 gate ledger), `.dev/`
(recon reports + RPC endpoint contract + snapshots). Tests: `pnpm run verify`.

## Changelog

- 0.1.0 `[VERIFY-BEFORE-RELEASE]` — first release; see TEST-PLAN ledger for what is
  actually green at build time.
