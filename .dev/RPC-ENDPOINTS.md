# RPC endpoint contract — /dsh-cortex-read | /dsh-cortex-write

Nama endpoint FROZEN di sini (M7 coding against this; modul wajib patuh). Payload
selalu object (boleh {}); respons `{ok,value}|{ok,error}` dibungkus transport.
Setiap handler sisi host: validasi tipe argumen manual, throw → error terarah, JANGAN
pernah bocor stack. `scope` opsional: {sessionId?, cwd?, projectId?} — host resolve
pid via store.pidFromCwd bila cwd diberikan; tanpa scope → proyek aktif sesi pemanggil
(bila konteks sesi tak tersedia: daftar global-only).

## read channel '/dsh-cortex-read'
- ping {} → {version, modules:{name:state}, stateRoot, configSnapshotSanitized}
- memory.list {track?, projectId?, archived?, branch?} → entries[]
- memory.search {query, tracks?, includeArchive?, limit?} → hits[{id,track,snippet,score,branches,archived}]
- todo.list {tracks?, openOnly?} → items[]
- logs.read {scope:'project'|'daily', date?, lastDays?} → {date, text}[]
- pending.list {} → items[{id,kind,payload,createdAt,origin}]
- prompts.list {category?, includeDisabled?} → docs[{id,title,category,enabled,bodyChars}]
- prompts.get {id} → doc (body penuh, ter-cap 32KB utk UI)
- rooms.list {} → rooms[{id,title,members[{sessionId,label,status,lastSeen}],lastSeq}]
- rooms.read {roomId, sinceSeq?, limit?} → messages[{seq,from,text,images,at}]
- rooms.status {roomId} → members[{sessionId,label,status:'running'|'idle'|'gone',model,cwd}]
- jobs.list {limit?} → jobs[{id,runner,status,startedAt,finishedAt,exitCode,summaryChars}]
- jobs.logs {jobId, tailBytes?} → {stdout, stderr, truncated}
- status.self {} → (dipakai kartu error M7; sama dg ping + detail modul)

## write channel '/dsh-cortex-write'
- pending.approve {id} → hasil per-kind (entry id / todo id / prompt id) — SATU-SATUNYA
  jalur tulis memori utk konten usulan AI; hanya dipanggil UI.
- pending.reject {id, reason?} → ok
- memory.update {id, patch{content?,importance?,tags?,branches?}} → entry
- memory.archive {id} | memory.restore {id} → ok
- memory.delete {id, confirm:"DELETE"} → ok   (confirm persis; purge lihat tool)
- todo.add {track,text,important?,urgent?,due?} → item (jalur UI manusia: LANGSUNG, tanpa pending)
- todo.complete {id} | todo.remove {id} → ok
- prompts.save {id?, title, body, category?} → doc (jalur UI: langsung)
- prompts.toggle {id, enabled} → ok
- prompts.delete {id, confirm:"DELETE"} → ok
- inject.now {promptId?, text?, targetSessionId, mode:'once'|'sticky'|'clear'} → queue state (UI utk user-inject manual; label jujur tetap melekat)
- rooms.create {title} → room
- rooms.post {roomId, text, imagePaths?[]} → message (imagePaths wajib di dalam state root; validasi tipe mime + ukuran)
- rooms.join {roomId, sessionId, label?} → ok
- rooms.leave {roomId, sessionId} → ok
- rooms.spawn {roomId, label, prompt, cwd?, provider?, model?} → {sessionId} | refusal jujur (feature-detect agents.create di host)
- rooms.send {sessionId, text} → ok | refusal (sesi tak hidup; tidak auto-create)
- jobs.retry {jobId} → newJobId (hanya bila runner masih terdaftar & enabled)
- jobs.cancel {jobId} → ok
- purge.request {} → {confirmToken} ; purge.exec {confirmToken, confirm:"DELETE-CORTEX-DATA"} → ok (token satu-kali, umur 5 menit; token dibuat di memori host)

Tambahan modul dicatat di bawah file ini oleh pemilik modul (append-only, dengan
tanggal). M7: mock adapter = fixture statis per endpoint di atas.


## APPEND (parent, wave-1 integration 2026-09-15): live endpoint inventory
read  '/dsh-cortex-read':  ping, memory.list, memory.search, todo.list, logs.read,
                           rooms.list, rooms.read, rooms.status, sessions.status,
                           jobs.list, jobs.logs, jobs.get*, jobs.result*   (* M6 additions)
write '/dsh-cortex-write': pending.approve (BY-KIND dispatcher -> memory approver; other
                           kinds answer unsupported-kind), pending.reject, memory.update,
                           memory.archive, memory.restore, memory.delete, todo.add,
                           todo.complete, todo.remove, rooms.create, rooms.post, rooms.join,
                           rooms.leave, rooms.spawn, rooms.send, jobs.cancel, jobs.retry
NOTE: sessions.status + jobs.get/result extend the frozen contract (documented deviation).
NOTE: 'cortex:store' in C4 grep is a store.ts LOG PREFIX, not a prompt context — ignore.

## APPEND (M4 prompts, 2026-09-15): value shapes for prompts.* + inject.now

Names are exactly the frozen ones; this section only pins the `value` each handler
returns (all strings arrive `neutralizeDeep`-ed; an unknown/garbage argument is
`{ok:false,error:{code:'bad-request'|'not-found'|'disabled'|…,message}}`, never a throw).
GATE: with `prompts.enabled = false` every handler on BOTH channels answers
`code:'disabled'`, message `prompts are disabled by config (prompts.enabled = false); nothing was changed.`

read `/dsh-cortex-read`:
- prompts.list {category?, includeDisabled?} → {docs:[{id,title,category(string|null),
  enabled,bodyChars,createdAt,updatedAt}], total, includeDisabled, category?}
  (includeDisabled defaults TRUE — the panel wants the parked rows too; `false`
  filters to enabled only. Newest first, store's own order. No body here.)
- prompts.get {id} → {doc:{…as above…, body, truncated}} — body capped at 32 KB
  (`UI_BODY_CHARS`), `truncated:true` when it was. Unknown/unsafe id → not-found.

write `/dsh-cortex-write`:
- prompts.save {id?, title, body, category?} → {doc:{…summary fields…}, message};
  with `id` it EDITS that row (human path: writes the library directly, like todo.add;
  no pending row is created — that gate is the AI tool's only door).
- prompts.toggle {id, enabled:boolean} → {doc, message}; switching off also removes
  that prompt from every in-memory inject queue (`inject/<sessionId>.json`).
- prompts.delete {id, confirm:'DELETE'} → {id, deleted:true, message}; any other
  confirm string is refused with code 'confirm-required' and changes nothing.
- inject.now {promptId? | text?, targetSessionId, mode:'once'|'sticky'|'clear'} →
  {sessionId, queue:[{promptId(string,''+for typed text),mode,rounds,title,at}],
  lines:[string], message}. promptId and text are mutually exclusive; `clear` may
  omit both (whole queue) or name a promptId (one row). `rounds` counts the render
  that is about to happen (once → 1, sticky → 25 down to 0).

State shape (M4 module file, store path, additive to `InjectQueueItem`):
`inject/<sessionId>.json` = {sessionId, items:[{promptId,mode,at,rounds,title,body}],
updatedAt}. READS go through `store.readInjectQueue` (quarantine-tolerant). The
store's `injectPush`/`injectConsume` carry only {promptId,mode,at}, which cannot
express a sticky countdown or typed text, so M4 WRITES that file itself with
`lib/fsx.writeJsonAtomic` at `store.paths.inject()` (same path, same envelope,
rooms' consumed-ledger precedent); rows stay a superset, so a store-shaped row
(anyone's `injectPush`) is still readable and gets `rounds` seeded by mode.
TODO(PARENT): widen `InjectQueueItem` (rounds?/title?/body?) + add a store
`writeInjectQueue`/`clearInject`, then M4 can drop its own writer.
TODO(PARENT): route `pending.approve` kind 'prompt' to
`promptsModule.approvePendingPrompt(store, item)` — it exists and is tested; the
dispatcher currently answers 'unsupported-kind' for it, so an AI proposal can be
filed but not yet approved from the panel.
UI note (M7): `inject.now` needs `targetSessionId` (a panel click carries no
agent); the AGENT tool `cortex_prompt_inject` refuses any session but its own
('v1: inject applies to the calling session only').
