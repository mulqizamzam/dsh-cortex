# HOST API GROUND TRUTH — verified on dsh 0.1.1-rc.2 (2026-09-15)

> Written by the Orchestrator from direct source reading. **This file overrides any
> claim in `.dev/recon/RECON-SDK.md` drafts** (the first draft wrongly concluded
> plugins cannot register tools or inject context — they can; citations below).
> Every implementer: trust this + cited files, re-verify with `read` before use.
> ⚠️ `.dev/recon/RECON-SDK.md` is a SUPERSEDED draft: it denied tool-registration/injection
> (false) and cites several paths that do not exist in the checkout (phantom:
> `packages/client/plugins/src/define-client.ts`, `packages/client/ui-primitives/src/slots.ts`,
> `packages/client/connection/src/client.ts`). Do not implement from its citations.

Primary sources:
- Host: `/home/administrator/deepseek-harness` (v0.1.1-rc.2)
- Proven live plugin on THIS host: `/home/administrator/agent-workspace/dsh-custom/plugins/dsh-mnemon` (its `src/host/dsh.ts` is a faithful typed model of the host surface; cross-checked against host source)

## 1. Plugin entry (Cordis plugin, host-side)

```ts
export const name = 'dsh-cortex'
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents'] // cordis service deps
export function apply(ctx: HostContextShape, config: CortexConfig): void { /* must never throw */ }
```
Evidence: dsh-mnemon `src/host/plugin.ts:19-35` (`provide` also allowed), `inject` list at :21.
- `Config` schemas use **schemastery** (`z` from `@deepseek-ai/schemastery`): mnemon `host/plugin.ts:47`, host schedule `packages/schedule/schedule/src/index.ts:33-35`.
- **P4 rule**: wrap the entire `apply` body in try/catch; internal failure = disable module + console.warn, NEVER rethrow (memory-evolve killed the GUI by throwing from apply at boot).

## 2. Agent tools

`ctx.tools.register(defineTool({...}))` — first-party everywhere.
Evidence: host `packages/subagent/tool-subagent-control/src/index.ts:26,79`; `packages/subagent/tool-subagent/src/index.ts:308`; mnemon `src/host/tools.ts:62`.
ToolDefinition shape (mnemon `src/host/dsh.ts:85-98`):
```
{ name, description, parameters: JSONSchema(object subset),
  output: { schema, render(args, value) -> [{type:'text',text}], presentationMeta? },
  execute(args, execution) : Promise<value>,
  presentCall?(args), presentResult?() }
```
`execution: { signal: AbortSignal, agent?: HostAgent, concludeTurn?(): void }` (dsh.ts:54-64).
- Schema subset: object/properties/required/enum/items/const only (host `assertSupportedJsonSchema`; see workflow tool rules + mnemon usage). No pattern/format/min-max reliance.
- `execution.agent` gives the CALLING agent → session id, cwd (via `agent.session.header.cwd`), options.model. This is how tools resolve project/branch scope.
- Name collision: `register` throws on duplicate id; use `cortex_` prefix (reserved host names include send_message/spawn_task/list_agents/wait_agent from tool-subagent-control + tool-agent-team).

## 3. Per-turn context injection (TWO sanctioned seams)

1. **`systemPrompt.context()` — CHOSEN for session-scoped data (M2 memory block, M3 todo
   digest, M4 prompt queue).** Verified in host source: event/registration
   `context(name, {name, order, text: string | ((ctx: AssembleContext) => string)})}`
   (`packages/core/system-prompt/src/index.ts:78-85, 398-407`; text evaluated per
   assembly with that context `:527`); the running agent IS in the runtime context —
   `assembleContextFor: (agent, signal) => ({agent, scope: agent, ...})`
   (`packages/core/agent/src/dispatch.ts:174-176`, called from agent-loop
   `agent.ts:230`) — despite the base `AssembleContext` type only declaring
   `{scope?, signal?}` (cast `ctx as {agent?}`; if agent absent -> contribute '').
   Duplicate `name` registration THROWS; returns cordis disposer.
2. **Global static section** for guidance text: `ctx.get('systemPrompt').section({name, order, text: () => string})` (mnemon `guidance.ts:24-30`).
3. (Still available if needed) per-agent waterfall `agent.ctx.on('system-prompt/assemble', (assembly, context, next) => …)` — assembly = `{sections[], contexts[], tools, variables}`; and `agent/pre-step` (`{kind:'enter',messages}`) for room mail; `agent/turn-stopping`, `session/event` for turn end/status (mnemon lifecycle.ts:274-281, :1032-1045; host `index.ts:31,533`).
- **Honesty (P1)**: every injected text begins with the label line; never disguise as user.

## 4. Settings

There is **no plugin-side settings registration** on the current host. The
Loader validates the entry's raw config against the plugin's exported
**schemastery** schema (UNSCOPED npm pkg `schemastery@^3.18.0`) before `apply`,
and the host settings service projects that schema into a generated form on its
own (`packages/settings/settings/src/index.ts`: `SettingsForms.describe()` reads
each entry's Config through the configEditor; no `ctx.settings.register` exists
any more). `Config` must stay `Schema.object({... every field .default() ...})`
so a `{}` patch resolves completely.

A settings edit writes the profile patch and **hot-reloads the entry**, which
re-invokes `apply` with the new validated config — there is no live-swap event
(`settings/updated` was removed; `settings/document-updated` is a UI revision
notification, not a config payload). Consequence for this plugin: every
registration (tools, RPC channels) hands its disposer to `ctx.effect`, so a
superseded boot releases its contributions before the next one mounts.

⚠️ PROFILE PATCH RULE: a patch row targeting `id: dsh-cortex` REPLACES THE ENTIRE config value
(no deep merge) — README must restate all keys in any example override
(`docs/user/develop/basic/publish.md` + `packages/bundle/base/cordis.patch.yml:5-7`).

## 5. Client ⇄ host transport (DO NOT USE webServer /api)

```ts
ctx.inject(['connection'], (c) => {
  if (!c.connection) return
  c.connection.rpc.handle('/dsh-cortex-read',  handler)   // returns an async disposer
  c.connection.rpc.handle('/dsh-cortex-write', handler)
})
```
Client (inside client plugin with `inject:['connection']`): `ctx.connection.rpc.call(channel, endpoint, payload, signal?)` →
`{ok:true, value} | {ok:false, error:{code,message}}`.
Evidence (all verified in source, 2026-09-15): `packages/client/connection/src/rpc.ts:5-11` (`ConnectionRpcAuthority`, "trust fence applied before a Host RPC channel reaches its handler"; `handle(channel, handler, {authority})` :33), `src/client/rpc.ts:26` (`call(channel, endpoint, payload, signal)`); mnemon usage `plugin.ts:118-137`, `client/remote-rpc.ts:65`, `host/protocol.ts:27-31` (channel names `/dsh-mnemon-*`).
- Authority options seen used: `'loopback'` (default) / `'trusted-host'` (mnemon maps remoteAccess to this). Keep `loopback` for everything; writes require a **UI-issued capability token** we mint per page session (belt-and-braces; P3).
- **2026-10-09 update (verified against host 0.2.0-rc.2):** the current host's
  `handle()` takes `(channel, handler)` only — `ConnectionRpcAuthority` and the
  options argument were removed (`packages/client/connection/src/rpc.ts:173`),
  and Connection now applies its own Host/Origin + browser-auth trust to every
  registered channel. Do not pass an authority option.
- This closes the audit's #1 memory-evolve defect (3/73 mutation handlers guarded) by construction: our ONLY attack surface is two authenticated rpc channels.

## 6. Sessions: status, messages, spawn

- Live: `ctx.agents.roots(): HostAgent[]`, `get(id)`; `HostAgent = { id, status:'idle'|'running', options{provider,model,maxTokens}, session{header{cwd,...}}, followup(msg), steer(msg), inject(msg) }` (mnemon dsh.ts:186-195). Room status comes from here (session/event for freshness).
- Spawn (host): `ctx.agents.create?({ sessionId, meta:{cwd,...}, agentOptions?, setup? })` — **factory only after an agent-loop plugin is loaded**; treat as OPTIONAL at runtime: feature-detect `typeof ctx.agents.create === 'function'`; if absent, fall back to client path below. (Registry source: host `packages/core/agent/src/index.ts:405`; NO_FACTORY error at :217.)
- Spawn (client): NOT available to plugins on rc.2 — official client plugins only see `ctx.sessions.list` (snapshot with `current` + `byId`), `.open`, `.binding`; no create/send surface proven (grep `ctx.sessions.` across packages/client/ui-*). Therefore **all spawn goes through host `ctx.agents.create`**; if feature-detect fails, `cortex_session_spawn` returns a clear refusal and rooms still work by joining EXISTING sessions (`ctx.agents.roots()` + `cortex_room_join`).
- Message images v1: store under `rooms/<id>/images/`, inject honest text mail with absolute path; receiving agents view via the host's own read_image tool (present in web profile tool-fs). Native attachment blocks (`HostUserMessage.content[] type:'image' attachment.attachmentId`) via host service `attachments` (`ctx.get('attachments')`, `ctx.inject(['attachments'],...)`; evidence host `packages/fs/tool-fs/src/index.ts:70`, `read-image.ts:163-201`) — upgrade only if trivial; NEVER required for v1.

## 7. Subagents service (for in-process delegated agents; distinct from CLI delegation)

`ctx.subagents.list(): string[]`, `getProvider(name)`, `start(name, {label, prompt[], parent, signal, agentOptions?, outputSchema?, toolFilter?, persona?, maxDepth?}) -> {id, result: Promise<{output[], stopReason}>, dispose()}` (mnemon dsh.ts:236-262). Use: cortex can offer `cortex_agent_delegate` writing to host subagent providers (spawn/fork...) — optional, off by default.

## 8. Data root & install shape

- State root: prefer host SERVICE `dshHomePath('dsh-cortex')` (`ctx.provide('dshHomePath', …)` app-boot `src/index.ts:770`; def `packages/util/home-paths/src/index.ts:98`) — uses the exact home the running host resolved (immune to non-login-shell DSH_HOME gaps, see MEMORY gotcha). Constructor-injected root for tests; `(process.env.DSH_HOME || ~/.dsh)/dsh-cortex` ONLY as last-resort fallback (same join logic as home-paths). No !!js in user-facing config examples; a plain `stateRoot` config field overrides everything.
- Package: name `dsh-cortex`; `"dsh": { "bundle": { "patch": "cordis.patch.yml" }, "engines": { "dsh": ">=0.1.1-rc.1" } }`, `type: module`, `main: lib/index.js`; client part declared `"dsh": { "client": { "inject": ["slots"], "platform": "web", "external": [] } }` on the client entry — follow dsh-session-readcache `package.json` + `cordis.patch.yml` (insert row) and mnemon-source-runtime `package.json` (client field).
- Install (VERIFIED G4b 2026-09-15, throwaway DSH_HOME): `dsh plugin --profile web add link:<abs-pkg-dir>` writes dep row, AUTO-reconciles `dsh.profile.bundles`, creates relative symlink; `remove` reverses all three (profile delta empty; row gone from `--dump-config`). Prebuild `pnpm run build` inside the plugin first (lib/ must exist). Belt-and-braces post-add check: `dsh --profile web --dump-config | grep dsh-cortex`.
- Build: tsdown (`exports` map + lib/), tsconfig per mnemon root; local dev link needs `pnpm -r build`-style prebuild before restart (lib/ untracked gotcha).

## 9. Client UI slots (React) — VERIFIED against dsh-mnemon + host source (draft "dsh.slots.add('page.section')" was WRONG)

Real client-plugin shape (mnemon `src/client/index.ts`, live on this host):
```ts
export const name = 'dsh-cortex-client'
export const inject = ['slots', 'sessions', 'workspaces', 'connection', 'locale']
export function apply(rawContext: unknown): void {
  const ctx = rawContext as ClientContext  // { slots, sessions?, workspaces?, connection, locale, effect }
  ctx.effect(() => ctx.locale.register('cortex', { zh, en }), 'cortex: locale')
  const translate = ctx.locale.bind('cortex')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'cortex', order: 30,
    label: () => translate('settings.title'), locale: 'cortex',
    inject: () => ({ connection: ctx.connection, /* sessionId via ctx.sessions.list.getSnapshot().current */ }),
  }, CortexSettingsCard))
  // per-session tab/workspace: ctx.slots.inject('conversation.view', () => ctx.slots.register({...}, CortexPanel))
}
```
- Slot factory returns a DISPOSE fn; `ctx.slots.inject(name, make)` toggles cleanly (see mnemon reconcile pattern for enable/disable without reload).
- Ground-truth slot ids in host source (grep `slots?.inject('` under packages/client): `settings.section`, `settings.plugin.item`, `settings.plugins.tab`, `conversation.view`, `conversation.composer`, `conversation.input.dock`, `conversation.chat.node`, `conversation.chat.assistant-actions`, `sidebar.settings`, `sidebar.workspaces`, `conversation.hero.workspace`, etc.
- Client reads sessions list live: `ctx.sessions.list.getSnapshot()` → `{ current, byId }` (each row has `.cwd`); workspaces: `ctx.workspaces.list.getSnapshot().items` → `{workspaceId, path, title}`.
- Locale IS available client-side (`ctx.locale.register/bind`) — the draft's "no locale" was about web-profile root bundles, not client plugins. Use dictionaries {zh,en} like mnemon; EN fallback required.
- Build: `"dsh.client.inject"` lists PACKAGE NAMES of browser modules whose services the entry consumes (they become shared externals), NOT service strings. Authoritative live example (dsh-mnemon ROOT package.json): `{"client": {"inject": ["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-locale"], "platform": "web"}, "bundle": {"patch": "./cordis.patch.yml"}}`. Cortex needs at minimum: connection + ui-conversation (conversation.view rows) + locale; `slots`/`sessions`/`workspaces` ride defaults/preloaded runtime (`packages/client/web/src/platform.ts` list). exports: `.` → lib/index.js, `./client` → lib/client.js (+ lib/types/*.d.ts per ui-trajectory pattern).

### 9.5 Purity + slot-cell rules (from RECON-SDK final, §3.2–3.3; source: `packages/client/tsdown.client.ts:472-495`, `packages/client/ui-slots/src/index.ts:706-798`)
- Cross-plugin value imports are FORBIDDEN at client build time — type-only imports only (`import type {} from '@deepseek-ai/dsh-client-*-client'` for Context merges / SlotMap rows). Default shared externals: react, react/jsx-runtime, react-dom/client, @deepseek-ai/cordis, dsh-client-ui-slots, dsh-client-ui-primitives, dsh-client-runtime/client. `@deepseek-ai/schemastery` + `cosmokit` may inline; anything else must go in `dsh.client.external` (exact match) or be bundled inline.
- Slots have kinds: single/keyed/list/chain. `register` into an UNDECLARED slot throws; list cells with equal priority throw naming the occupant → always `id:'cortex'`, pick a non-0 `order`, and wrap every registration in try/catch (P4). NEVER register into `'root'`; floating surfaces use `'shell.overlay'` (list).
- `conversation.view` = list slot, session scope — correct mount for the Cortex session panel; `settings.section` = settings page (mnemon uses order 20 → use 30).

## 10. Reserved names, invariants, and crash-traps (RECON-SDK FINAL, machine-validated citations)

- **`export const Config` MUST be a real schemastery schema, never a plain object** — cordis
  `vendor/cordis/src/fiber.ts:50-62` calls `Config['~standard'].validate` whenever truthy →
  plain object = boot crash. (Our `src/host/config-schema.ts` complies.)
- **Client bundle id invariant**: `window.__ModuleLoader__.load({id})` must EQUAL the loader
  entry `name` in cordis.patch.yml (`packages/client/modules/src/client/system.ts:120`
  otherwise `loaded without registering`). Ours: both `dsh-cortex` — keep synced.
- **Duplicate loader row `id` throws** (keyed on id, not `name`: `vendor/loader/src/config/group.ts:64`)
  → README must warn users NEVER to also hand-insert our row.
- **`inject` typos fail silent-but-loud-at-boot**: audit line `dsh: N entries did not activate …
  pending (waiting for service: x)` (app-boot `src/index.ts:716-719`) → use as boot assertion in G4.
- **No host-side timers/scheduler service; no `session.status` RPC** (status rides push frames);
  `RpcMethodMap` is closed — channels via `connection.rpc.handle` is THE route (what we do).
- `dsh.engines.dsh` key is DEAD (never read) — do not rely on it for compatibility claims.
- Tool names: never reuse host reserved (`send_message`, `spawn_task`, `followup_task`,
  `list_agents`, `wait_agent`, team-* from tool-agent-team) and never `de_*`.
- Duplicate tool name = register throws → `registerToolSafe` everywhere (P3).

## 11. Events to use (proven names)

`agent/created`, `agent/session-start`, `agent/turn-stopping`, `agent/pre-step`, `session/event` (payload `(session, event)`; `event.type === 'turn/end'` etc.), `tools/result`, `settings/document-updated`, `loader/partial-dispose` (cleanup). Evidence: mnemon lifecycle.ts + plugin.ts (grep `ctx.on('` in dsh-mnemon/src/host).
