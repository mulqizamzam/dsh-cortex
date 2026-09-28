# Conflict Detection — dsh-cortex

Lightweight "heads up" for concurrent file writes in a room. Not a full 2PC —
just path-matching detection before commit.

## Design

### Why

When two agents in the same dsh-cortex room both try to write to the same file,
the later write silently clobbers the earlier one (last-writer-wins on the store's
atomic write paths). This causes subtle bugs in multi-agent workflows where the
orchestrator has no visibility into which agent "owns" a file.

### Contract

Three-step declare → check → release protocol:

1. **Declare** — an agent calls `cortex_conflict_declare` with `(roomId, path, description, ttlSeconds?)`.
   The service records the claim and returns a `claimId`. If another session has
   already claimed the same path in the same room, the response includes a
   `conflicts` array with details.

2. **Check** — before starting a write, the agent calls `cortex_conflict_check`
   with `(roomId, path?, sessionId?)`. Returns:
   - `hasConflict: true` + list of conflicting claims from other sessions
   - `ownClaimId` for the caller's own claim (if any)
   - `allConflicts` when no specific path is given (room-wide view)

3. **Release** — when done, the agent calls `cortex_conflict_release` with
   `(claimId)`. This frees the path for other sessions.

### Key properties

- **In-memory only** — no persistence. A host restart clears all claims.
  This is intentional: the goal is real-time coordination, not audit.
- **Path-scoped** — claims are keyed by `(roomId, absolutePath)`, not by
  session or project. Two sessions in the same room working on different
  files never interfere.
- **Auto-expiry** — `ttlSeconds` lets a claim self-clean when the agent
  forgets to release. `ttlSeconds: 0` = never expire (default).
- **Room isolation** — the same path claimed in different rooms is not a
  conflict. This matches the "2 agents in 1 room" requirement.
- **Opt-in** — the agent must explicitly declare intent. The system does
  not intercept write calls; it only reports declared conflicts.
- **No enforcement** — this is advisory. The `cortex_conflict_check`
  returns a warning but does not block the write. Whether to proceed is
  the orchestrator's (or agent's) call.

### What this is NOT

- Not a file lock (no blocking, no OS advisory lock, no `flock`).
- Not a two-phase commit (no prepare/commit/abort phases).
- Not a write interceptor (no monkey-patching of `fs.writeFile`).
- Not a persistent audit log (in-memory, volatile on restart).

### Limitations

- Agents that don't call `cortex_conflict_declare` are invisible to the
  detector — the system only knows about declared intents.
- A restart between declare and release loses all state. TTL mitigation
  helps for short-lived work.
- Same-session re-declaration overwrites the previous claim (same key).
  This is by design: one claim per (session, path) is enough.
- No cross-room awareness. A path claimed in room A is invisible to
  room B. This is intentional (room = team context).

### Extension points

- **Room notification**: DONE. `ConflictService.declare()` calls
  `notifyRoom()` (fire-and-forget) whenever it detects a conflict, so the
  orchestrator sees the heads-up as a system message in the room without
  polling. A post failure warns; it never fails the declare.
- **Delegation integration**: DONE. `DelegateService.dispatch()` auto-declares
  the job's cwd when the job is room-linked (TTL = `delegation.jobTimeoutSec`,
  so an orphaned job cannot leak a permanent claim) and persists the claim id
  on `job.conflictClaimId`; `finalize()` releases it on every terminal status.
- **Tool result warning**: `cortex_room_post` could call
  `svc.check({ roomId, path })` on the posting session's declared claims
  before sending, and append a warning to the post result. NOT DONE.
- **Persist claims to disk**: If audit is needed, add a `claims/`
  subdirectory under the state root with one JSON file per claim. NOT DONE.

### Live verification (2026-09-27, 4 host restarts)

Verified against the running web host, in room `31b8498c3146`. Nothing below
is inferred from source or unit tests — every line is a tool result.

- `cortex_status` reports module `conflict` state `ok` with all four tools
  actually held by the host registry.
- **Two agents, same path** — `declare` as `agent-1` then `agent-2` returns
  `CONFLICT: 1 other session(s)`, and a `conflict-detector` system message
  lands in the room transcript (seq 1). The orchestrator gets the heads-up
  without polling.
- **Negative case** — `declare` with `/etc/passwd` is refused: outside the
  state root.
- **Delegation auto-declare** — job `33551c0cec27` (runner `cortex-verify`)
  dispatched room-linked; `conflictClaimId` appeared in the dispatch result and
  was observable in `conflict_list` while the process was alive
  (`description: "delegate job 33551c0cec27 (runner: cortex-verify)"`).
- **Delegation auto-release** — the claim disappeared from `conflict_list` once
  the job settled. Proven on BOTH a `succeeded` job and a `timeout` job, so the
  release is not tied to success.
- **Conjunction (the objective)** — job `5417f71f3a20` running, then
  `declare` as `agent-2` on the job's claimed path returned
  `CONFLICT: 1 other session(s)`, and the conflicting claim was the delegation
  claim, not a hand-made one. Room seq 3 flagged it to the orchestrator.

### Defect found by this live run, and fixed

`relative(stateRoot, stateRoot)` is `''`, so a claim on the state root itself
— exactly what a delegation job makes, since it claims `cwd` — rendered an
EMPTY path. The room message read `path(es): - Sessions involved: …` with no
file named, and `declare` read `declared intent to write  in <room>`.

`displayPath()` now falls back to the absolute path when the relative form is
empty, and is used at all three render sites (declare message, check message,
room notification). Confirmed live: room seq 3 (before) vs seq 4 (after). Two
regression tests cover it.

Full suite at close: 677 passed / 1 skipped, 40/40 files, build clean.

### Tools

| Tool | Purpose |
|------|---------|
| `cortex_conflict_declare` | Declare intent to write a file in a room |
| `cortex_conflict_check` | Check for conflicts on a path (or room-wide) |
| `cortex_conflict_release` | Release a claim when done writing |
| `cortex_conflict_list` | List all active claims (debug / orchestrator view) |

### Teardown of the live-proof setup

To prove the delegation path live, the web profile carried a temporary override
(`profiles/web/cordis.patch.yml`, row `- id: dsh-cortex`) that set
`delegation.enabled: true` and registered one inert runner (`cortex-verify` =
`node -e setTimeout(…)`, no side effects). Backups taken before each edit:
`cordis.patch.yml.bak-verify-20260927-232032` and `cordis.patch.yml.bak-sleep-*`.
Removing that row returns delegation to its shipped default (OFF).
