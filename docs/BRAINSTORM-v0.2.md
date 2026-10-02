# Brainstorm dsh-cortex v0.2.0+ — Structured Backlog

Board: `73494a803cac` ("Brainstorm dsh-cortex") · Room `c1303f6debfa` ("idegila")
Agent: `session-41367623…` · 2026-10-02
Method: read-only audit of source + state root + tests + DESIGN/PRD/HOST-API. Evidence baseline: **799 tests pass, 1 skipped** (vitest). 14 modules wired, 51 unique cortex_* tool names in source (35 PRD-counted; board=7, conflict=4, decisions=4, delegate=6, logs=2, memory=7, prompts=5, purge=1, rooms=7, sessions=2, status=1, todo=4). Client tabs: Memory | Todo | Rooms | Board | Prompts | Jobs.

This document is the compaction of brainstormed ideas into decisions. "Backlog" = enhancement ideas. "In-progress" = under discussion. "Done" = matured to decision.

---

## BACKLOG — Enhancement ideas (enhancement)

### B-01 · Pending queue: `cortex_pending_list` / `cortex_pending_reject` / delete
**Area:** Gap design↔impl. **Evidence:** memory `TOOLS` array (memory/index.ts:45-53) has 7 tools — `cortex_pending_list` and `cortex_pending_reject` are DESIGN §4 "DITANCANG tapi belum diimplementasikan". Approve/reject exist only via the UI panel (memory/store decide() is present but unreachable by AI).
**Idea:** Add 3 tools: `cortex_pending_list {status}` (read), `cortex_pending_reject {id}` (AI can reject a bad proposal), `cortex_pending_delete {id}` (remove stale proposals; guard who may delete). Enables multi-session proposal workflow where one agent can prune another's junk.

### B-02 · Board dependency auto-unblock + room notify
**Area:** Inter-agent coordination. **Evidence:** board/service.ts:195-207 `moveCard` only updates status; no scan of dependents. Card.dependencies exists in the type but nothing acts on it.
**Idea:** On move→done, scan board cards for dependents; auto-comment "unblocked by <id>"; optionally post room message. Cap cascade depth (config `board.autoNotify`, default OFF per P3).

### B-03 · Client: Decisions tab (zero-UI module → surface)
**Area:** UX / feature gap. **Evidence:** decisions module is fully built (4 tools, 3 test files, store add/list/get/update/link) with **zero client surface** — no tab, no rpc endpoint in panel. Highest-ROI unbuilt feature.
**Idea:** New `decisions` tab in panel-model.ts TABS + panel.ts renderer; endpoints `decisions.list/get/link`; link decisions↔memory entries.

### B-04 · Handoff protocol: formalize + user toggle
**Area:** Feature completion. **Evidence:** sessions/handoff.ts + spawn.ts:276-313 already wire handoff when `cfg.handoff.enabled`; config exists but there is no UI toggle and no frozen block format doc. 11 tests exist.
**Idea:** Freeze the block format; add per-session UI toggle; extend config (`handoff.maxLines`, `includeTodos`).

### B-05 · Memory provenance (source quote + history)
**Area:** Honesty (P1-adjacent). **Evidence:** Entry.source typed `{sessionId?, quote?}` (types.ts:23-27) but quote rarely populated; no `cortex_memory_history {id}`; render only shows `from:` origin tag.
**Idea:** Tool to see who/what changed an entry; renderer highlights provenance.

### B-06 · Memory export/import bundle
**Area:** Migration / backup. **Evidence:** store lists all entries; no serialize path; purge is delete-only. No cross-machine sync by design (non-goal) but local backup is missing.
**Idea:** `cortex_memory_export {format:'json'|'md'}` and `cortex_memory_import` (→ pending, respects autoAccept).

### B-07 · Project auto-resolution fallback (headless/unknown cwd)
**Area:** Reliability. **Evidence:** store.addEntry requires pid for project track; sessions with no cwd or non-git dirs can't create project memories.
**Idea:** Anonymous `<unknown>` project id fallback, or explicit `cortex_memory_create` that refuses ambiguity loudly.

### B-08 · Mnemon coexistence bridge (read-only)
**Area:** Cross-plugin integration. **Evidence:** both plugins inject memory blocks into the same session (PRD §1 "koeksistensi"); DESIGN §1 says cortex must not copy mnemon semantics. Today: two labeled blocks, no shared budget.
**Idea:** Optional read-only import of mnemon hot-memory into cortex's budget accounting, or a shared `inject.*` budget. Must preserve P3 (default OFF) and never write into mnemon's root.

### B-09 · Delegation: branch-scoped write-back
**Area:** Reliability. **Evidence:** Job persists cwd/pid but not branch; handoff renders branch but job write-back doesn't.
**Idea:** Capture branch at spawn; tag write-back log lines; opt-in config.

### B-10 · Progress report delta ("since last report")
**Area:** UX. **Evidence:** progress/service.ts source() has no time filter; report always dumps open todos + newest entries + today's log.
**Idea:** `{since}` param; default yesterday; summary counts.

### B-11 · Room image compression / state-quota safety
**Area:** Reliability (quota). **Evidence:** rooms images capped 8 MB/file × 8/message with no compression; store quota 64 MiB shared. A few big pastes can eat the whole quota.
**Idea:** Compress/thumbnail on copy, or reserve quota headroom for images vs memory.

### B-12 · Room cursor pagination
**Area:** UX/scale. **Evidence:** readMessages has sinceSeq + newest-window only; panel "load older" re-fetches a wider window and dedupes client-side.
**Idea:** beforeSeq cursor for large rooms (>200 msgs).

---

## IN-PROGRESS — Under discussion (in-progress)

### I-01 · Confirm-string contract drift (purge) — NEEDS DECISION
**Area:** Security hardening + doc↔impl gap. **Evidence (verified):**
- Code: `src/host/modules/purge/index.ts:21` `PURGE_CONFIRM = 'PURGE_ALL_CORTEX_STATE'` (tool description repeats it).
- DESIGN.md:142 and PRD/DESIGN still document `confirm:"DELETE-CORTEX-DATA"`.
- `.dev/RPC-ENDPOINTS.md:47` describes a two-step `purge.request → confirmToken` + `purge.exec` flow (5-min token) that is NOT what the shipped tool does.
**Risk:** A user (or agent) copying the documented string gets refused; worse, the doc shows a capability-token design that the implementation dropped.
**Proposal:** Align DESIGN.md + RPC-ENDPOINTS.md to the shipped `PURGE_ALL_CORTEX_STATE`, OR (preferred for security) adopt the two-step confirmToken flow so the destructive op needs a UI-minted token, not a literal a model can emit. Also gate purge so it is never callable by an agent tool without explicit human confirm param.

### I-02 · AI-callable mutations vs P3 safe defaults — NEEDS SCOPE DECISION
**Area:** Security hardening. **Evidence:** `memory.autoAccept=false` routes AI writes to pending/ (P3), but `cortex_memory_update/archive/delete`, `cortex_todo_*`, `cortex_log_append`, `cortex_room_post`, `cortex_board_*` are all directly agent-callable writes with no confirm. Delete has a two-step token for memory only.
**Proposal:** A per-module "AI may write" policy surfaced in cortex_status, defaulting mutations that lose data (delete/archive/update existing) behind a human-approve path like memory.autoAccept. Keep additive writes (todo add, log append) agent-callable.

### I-03 · Observability: cortex_status depth + per-op counters — PROPOSED
**Area:** Reliability & observability. **Evidence:** cortex_status reports module wiring + boot errors; no counters for inject-block bytes actually served, tool error rates, quarantine events, or store read failures. `runtime().errors` is ephemeral.
**Proposal:** persist a small rolling health file in the state root (counts: writes refused by quota, quarantined reads, inject bytes/truncation, per-tool failures). Show last-N in the panel. Must not write outside state root (P5).

---

## DONE — Compacted decisions (done)

### D-01 · Decisions tab is the highest-ROI v0.2.0 item
**Decision:** Ship a `decisions` client tab in v0.2.0 P1.
**Rationale:** The module is fully implemented and tested (4 tools, 3 spec files) but invisible to the user — pure dead backend. Cheap win, real value (decision history is the "why did we do X" layer PRD claims).

### D-02 · Board dependency auto-unblock, gated OFF by default
**Decision:** Implement; config `board.autoNotify` default false (P3).
**Rationale:** Dependencies are already stored but inert — the single most likely multi-agent failure is a silent stall. Opt-in keeps current behavior for existing rooms.

### D-03 · Purge confirm-string must be reconciled this release
**Decision:** Treat doc↔impl drift on the destructive op as a P1 bug, not a docs task.
**Rationale:** The one irreversible operation has three different documented contracts and none match the code. Fix by making one source authoritative and document it in DESIGN + RPC-ENDPOINTS + tool description identically. Prefer the two-step token for security if feasible; otherwise update docs to `PURGE_ALL_CORTEX_STATE` and require an explicit human confirm.

### D-04 · Memory provenance is P2 (P1-adjacent)
**Decision:** Add `cortex_memory_history {id}` + render provenance in v0.2.0.
**Rationale:** P1 honesty is the project's spine; "which session proposed this fact" completes the trust story and is cheap (types already carry `source`).

### D-05 · Config form stays a self-test this release
**Decision:** Do NOT build a settings form in v0.2.0; keep the honest "no form on purpose" card.
**Rationale:** The profile-patch REPLACES-the-whole-object rule (issue #44) makes a partial-key form dangerous. Not worth the risk until host supports partial writes. (Noted: a "read config → show current values" read-only view is still safe and could be P3 nicety.)

### D-06 · Export/import is P2 (migration safety, not a collaboration feature)
**Decision:** v0.2.0 P2.
**Rationale:** One disposable state dir means upgrades/moves need a backup path; but it's not blocking daily use.

### D-07 · Mnemon bridge is explicitly deferred past v0.2.0
**Decision:** No cross-plugin memory sharing in v0.2.0.
**Rationale:** Coupling to another plugin's internals risks both P5 (writes outside state root) and honesty (double injection). Current side-by-side labeled blocks are the honest, safe default.

---

## ROADMAP PRIORITY (v0.2.0)

**P1 (must):**
1. D-03 Purge confirm-string reconciliation (security + doc truth)
2. D-01 Decisions tab (highest ROI)
3. I-01/I-02 Security policy for AI-callable destructive mutations (scoped)
4. B-02 Board auto-unblock (gated OFF)

**P2 (should):**
5. B-01 Pending list/reject/delete tools (closes documented gap)
6. D-04 Memory provenance/history
7. B-04 Handoff formalization + toggle
8. B-06 Export/import bundle

**P3 (nice):**
9. I-03 Observability counters
10. B-10 Progress delta, B-12 room cursor, B-11 image compression, B-07 pid fallback, B-09 branch write-back

**Deferred (post-0.2):** B-08 mnemon bridge; semantic search; git sync (both explicit non-goals).

---

## OPEN QUESTIONS for the delegator
1. Tab budget: the panel already has 6 tabs; is a 7th (decisions) acceptable, or fold decisions into Memory as a sub-filter?
2. Purge: adopt two-step confirmToken (security) or just fix the docs to match `PURGE_ALL_CORTEX_STATE` (speed)?
3. AI mutation policy: should `memory.autoAccept=false` extend to delete/archive/update, or stay memory-write-only?
4. Mnemon: is there an official API to read hot-memory, or only the client module surface?

## VERIFICATION NOTES
- Test suite run: `pnpm test` → 65 files, 799 passed / 1 skipped, exit 0 (this session).
- Purge confirm drift verified by grep across src + DESIGN.md + .dev/RPC-ENDPOINTS.md.
- Module/tool counts verified via source grep (no runtime assumption).
