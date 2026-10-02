#!/usr/bin/env node
import { CortexStore, DEFAULT_CONFIG } from '../lib/index.js'
import { join } from 'node:path'
const ROOT = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'dsh-cortex') : require('node:os').homedir() + '/.dsh/dsh-cortex'
const store = new CortexStore({ root: ROOT, caps: { ...DEFAULT_CONFIG.caps }, warn: m => console.warn('[seed]', m) })
const ROOM = process.env.ROOM_ID ?? 'c1303f6debfa'
const BOARD = process.env.BOARD_ID ?? '73494a803cac'
const OWNER = 'session-41367623-f341-4501-8a85-65c68be7522b'
const CARDS = [
  { id:'B-01', status:'backlog', title:'B-01 Pending tools: list/reject/delete', desc:'memory TOOLS=7; DESIGN says pending_list/reject "DITANCANG tapi belum diimplementasikan". Add 3 tools. Closes documented gap.' },
  { id:'B-02', status:'backlog', title:'B-02 Board auto-unblock + room notify', desc:'board/service.ts:195-207 moveCard leaves dependencies inert. On done, scan + comment + room msg. Config board.autoNotify default OFF (P3).' },
  { id:'B-03', status:'backlog', title:'B-03 Client: Decisions tab (zero-UI module)', desc:'decisions module: 4 tools, 3 spec files, zero client surface. Add tab. Highest ROI v0.2 item.' },
  { id:'B-04', status:'backlog', title:'B-04 Handoff: freeze format + UI toggle', desc:'sessions/handoff.ts + spawn.ts:276-313 already wire handoff; no UI toggle, no frozen block format doc.' },
  { id:'B-05', status:'backlog', title:'B-05 Memory provenance/history', desc:'Entry.source typed but quote rarely populated. Add cortex_memory_history + render provenance header.' },
  { id:'B-06', status:'backlog', title:'B-06 Memory export/import bundle', desc:'No serialize path; purge is delete-only. Add export + import (→ pending). One-dir state needs backup.' },
  { id:'B-07', status:'backlog', title:'B-07 Project auto-resolution fallback', desc:'store.addEntry requires pid for project; sessions with no cwd/non-git dirs can.t create project memories.' },
  { id:'B-08', status:'backlog', title:'B-08 Mnemon coexistence bridge (deferred)', desc:'Both plugins inject blocks. Coupling to mnemon internals risks P5 + honesty. Deferred post-v0.2.' },
  { id:'B-09', status:'backlog', title:'B-09 Delegation branch-scoped write-back', desc:'Job persists cwd/pid but not branch. Capture branch at spawn; tag result.md + log lines.' },
  { id:'B-10', status:'backlog', title:'B-10 Progress report delta', desc:'progress/service.ts source() has no time filter. Add {since?} param; default yesterday 00:00.' },
  { id:'B-11', status:'backlog', title:'B-11 Room image compression / quota guard', desc:'8 MB x 8 files/message; shares 64 MiB state quota. Compress or reserve headroom.' },
  { id:'B-12', status:'backlog', title:'B-12 Room cursor pagination', desc:'readMessages newest-window only; panel loadOlderMessages refetches wider window. Add beforeSeq cursor.' },
  { id:'I-01', status:'in-progress', title:'I-01 Purge confirm-string drift (P1 security bug)', desc:'Code: PURGE_CONFIRM="PURGE_ALL_CORTEX_STATE". Docs: DESIGN:142 + .dev/RPC-ENDPOINTS:47 say "DELETE-CORTEX-DATA" + two-step token. Three contracts, none consistent.' },
  { id:'I-02', status:'in-progress', title:'I-02 AI-callable destructive mutation policy', desc:'memory.autoAccept=false routes AI writes to pending, but update/archive/delete, todo_*, log_append, room_post, board_* are directly agent-callable. Propose per-module "AI may write" policy.' },
  { id:'I-03', status:'in-progress', title:'I-03 Observability: per-op counters + health file', desc:'cortex_status reports wiring only; no persistent counters for quota refusals, quarantine events, inject bytes, per-tool errors.' },
  { id:'D-01', status:'done', title:'D-01 Decisions tab is highest-ROI v0.2.0 P1', desc:'Module fully implemented + tested but invisible. Cheap to surface, real value.' },
  { id:'D-02', status:'done', title:'D-02 Board auto-unblock gated OFF', desc:'Dependencies stored but inert; silent stall is the #1 multi-agent failure. Opt-in keeps current behavior.' },
  { id:'D-03', status:'done', title:'D-03 Purge confirm-string must be reconciled (P1 bug)', desc:'One irreversible op has three different documented contracts. Fix this release.' },
  { id:'D-04', status:'done', title:'D-04 Memory provenance is v0.2.0 P2', desc:'P1 honesty spine; completes trust story.' },
  { id:'D-05', status:'done', title:'D-05 Config form stays self-test in v0.2.0', desc:'Profile-patch REPLACE whole-object rule (issue #44) makes partial-key form dangerous.' },
  { id:'D-06', status:'done', title:'D-06 Export/import bundle is v0.2.0 P2', desc:'Disposable state dir needs a backup path; not blocking daily use.' },
  { id:'D-07', status:'done', title:'D-07 Mnemon bridge deferred past v0.2.0', desc:'Coupling risks P5 + honesty. Current side-by-side labeled blocks are the safe default.' },
]
let ok=0, fail=0
for (const c of CARDS) {
  const r = await store.addCard({ roomId: ROOM, boardId: BOARD, title: c.title, description: c.desc, status: c.status, ownerId: OWNER })
  if (r.ok) { ok++; console.log(`OK ${c.id} → ${r.data.id}`) }
  else { fail++; console.error(`FAIL ${c.id}: ${r.error}`) }
}
console.log(`\nDone: ${ok} ok, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
