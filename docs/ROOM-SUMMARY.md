🧠 **Brainstorm dsh-cortex v0.2.0+ — Summary**

**Agent:** `session-41367623…` (this session)
**Method:** read-only code audit — source, state root, tests, DESIGN.md, PRD.md
**Evidence baseline:** 799 tests pass (vitest), 14 modules wired, 51 cortex_* tool names in source (35 PRD-counted)

---

## 3 MATURE DECISIONS (ready to implement)

1. **P1 Bug: Purge confirm-string drift** — Three different contracts exist (`PURGE_ALL_CORTEX_STATE` in code, `DELETE-CORTEX-DATA` in DESIGN.md + RPC-ENDPOINTS, plus a two-step confirmToken flow described but not shipped). **Must reconcile this release.** Prefer two-step token (security) or align docs to shipped string.

2. **P1 Feature: Decisions tab** — 67 tests, 4 tools, zero client UI. Highest-ROI v0.2.0 item. Full module exists; just needs panel tab + RPC endpoints.

3. **P1 Feature: Board auto-unblock** — Dependencies stored but inert. Silent stall is the #1 multi-agent failure. Add scan-on-done + optional room notify, gated `board.autoNotify=false` (P3).

## 5 MORE DECISIONS

4. **P2: Memory provenance/history** — `Entry.source` typed but rarely used. Add `cortex_memory_history {id}` + render provenance header.
5. **P2: Memory export/import** — No backup path for the one-dir state. Add bundle tools (read-export, write→pending).
6. **P2: Handoff formalization** — Config exists but no UI toggle or frozen format doc.
7. **P3: Config form stays self-test** — Profile-patch REPLACE rule (issue #44) makes partial form dangerous; no write form in v0.2.
8. **P3: Mnemon bridge deferred** — Coupling to sibling plugin risks P5 + honesty.

## 8 BACKLOG IDEAS

B-01 Pending tools (list/reject/delete) — closes documented gap
B-02 Board auto-unblock + notify — P1 (above)
B-03 Decisions tab — P1 (above)
B-04 Handoff freeze + toggle — P2 (above)
B-05 Provenance/history — P2 (above)
B-06 Export/import — P2 (above)
B-07 Project pid fallback (headless sessions)
B-08 Mnemon bridge — deferred
B-09 Delegation branch-scoped write-back
B-10 Progress delta (since-last-report)
B-11 Room image compression / quota guard
B-12 Room cursor pagination

## OPEN QUESTIONS

1. Decisions tab: standalone (7th tab) or Memory sub-filter?
2. Purge: two-step token (secure) or align docs (fast)?
3. AI mutation policy: should memory.autoAccept extend to delete/archive/update?
4. Mnemon official API surface?

## HANDOFF COMMAND

Run from a shell that can write to `$DSH_HOME/dsh-cortex`:

```bash
cd /home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex
node scripts/seed-brainstorm-board.mjs
# OR post the room summary via the UI; it's at docs/ROOM-SUMMARY.md
```

The brainstorm artifact lives at: `docs/BRAINSTORM-v0.2.md`
