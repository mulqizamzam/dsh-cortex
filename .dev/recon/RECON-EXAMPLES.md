# RECON-EXAMPLES — dissection of WORKING local DSH plugins

Scope: read-only static inspection of runtime-verified local plugins under
`/home/administrator/agent-workspace/dsh-custom/plugins/` (referred to below as `$PLUG`),
plus the active profile `/home/administrator/agent-workspace/.dsh/profiles/web` (`$PROF`)
and cross-checks against the host checkout `/home/administrator/deepseek-harness` (`$HOST`, v0.1.1-rc.2).

Nothing outside this file was created or modified. No app was run or restarted.

Status: **complete** (all sections filled). Every claim carries `path:line`; paths
`$PLUG`/`$PROF`/`$HOST`/`$DSH_HOME` are defined above (`$DSH_HOME` =
`/home/administrator/agent-workspace/.dsh`). Confidence is stated per section.
`[verified]` = I read the cited line; `[inferred]` = derived, not directly proven;
`[unverified-claim]` = quoted from a doc/README without code proof.

## 0. TL;DR / quick answers

1. **A "bundle" is a package whose `package.json` declares `dsh.bundle.patch`.** That one field
   decides whether `dsh plugin add` folds it into `dsh.profile.bundles` and whether boot accepts
   it as a layer (`$HOST/apps/cli/src/plugin.ts:36-45`, `profile.ts:391-394`). Its patch file
   inserts exactly one row: `id: <feature>` (row id), `name: <package name>`, `config: {…}`.
2. **`link:` = a relative symlink inside the profile's `node_modules`** (verified with `ls -la`:
   `dsh-session-readcache -> ../../../../dsh-custom/plugins/dsh-session-readcache`). Everything
   the plugin `import`s must resolve from **the plugin's own directory** — free-search keeps its own
   `node_modules` (`@deepseek-ai/dsh-settings -> $HOST/packages/settings/settings`); the profile root
   does not have it.
3. **Host plugin contract** = ESM exports `{ name, inject, provide, Config, apply }`
   (`$HOST/vendor/cordis/src/registry.ts:100-133`). `Config` is optional — and exporting a truthy
   non-schema `Config` breaks boot (`vendor/cordis/src/fiber.ts:50-62`).
4. **Registration primitives, all seen working:** `ctx.tools.register(defineTool(…))`
   (free-search `lib/index.js:1992-1995`; tool-fs `src/index.ts:76`),
   `ctx.webServer.register({kind:'exact'|'prefix', path, handler})`
   (`$HOST/packages/host/webserver/src/index.ts:38-48`; free-search `:1887-1899`, memory-evolve
   `lib/api.js:846`), `ctx.systemPrompt.section(...)` / `.context(...)` for turn context
   (`packages/core/system-prompt/src/index.ts:53-84`; memory-evolve `lib/index.js:1681-1707`),
   `ctx.on('agent/pre-step', …, { prepend: true })` for durable per-step messages
   (`$HOST/packages/context/time-context/src/index.ts:170-208`), settings namespaces via
   `installSettingsSection` (`packages/settings/settings/src/index.ts:863-897`).
5. **Client UI is discovered, not imported:** the package needs `dsh.client.platform === "web"`,
   `exports["./client"]`, and a **live, non-disabled loader entry whose `name` equals the package
   name**; the served artifact is `/plugins/<id>/client.js?rev=<sha1>` and its content hash is the
   rev (`$HOST/packages/client/modules/src/index.ts:447-456,482-490,161-171`). That artifact must be
   `window.__ModuleLoader__.load({ id, factory })` with a `var module={exports:{}}` intro — the
   exact banner/intro/footer of `dsh-mnemon/tsdown.config.ts:56-60`, and the id must equal the
   package name (`dsh-memory-evolve/scripts/build.mjs:26-37`).
6. **Slots that matter for this build:** `settings.section` (own settings page),
   `settings.plugin.item` (card inside Plugins), `conversation.view` (session tab),
   `conversation.input.*` / `sidebar.*` (composer / sidebar surfaces) — enumerated from the host's
   `SlotMap` merges (§4.6, §5.4, §10.9).
7. **Nothing host-side goes live without a `dsh web` restart.** `dsh --profile web --dump-config`
   proves composition pre-restart; client-only changes can hot-reload if a `tsdown --watch` is
   rewriting `lib/client.js` and the HMR poll notices (§9.10-11).
8. **Every local plugin here has a sibling `<plugin>.local-link.md`** (Indonesian runbook, 0600,
   ~8 sections: layout / patch-vs-upstream / install / static gates / runtime verification /
   limitations / update & revert) — and no host code enforces it (§8).
9. **dsh-cortex scaffold:** one package, two faces, ~20 files; exact list, snippets and an
   install/verification checklist in §10.

### Confidence summary

| section | confidence | main residual uncertainty |
| --- | --- | --- |
| §1 profile wiring | high | whether `dsh plugin add` rewrote `bundles` at install time (§9.10 `[disputed]`) |
| §2 readcache | high | none (all 142 lines read) |
| §3 free-search | high for built artifacts | TS source absent; the `settings.installSection` branch is the *not-taken* one on rc.2 |
| §4 mnemon | high for manifests/patch/docs, medium for `lib/` internals | 8.8k lib lines not fully traced |
| §5 skin-switcher | high | no `tsdown.config.ts` present, so `lib/` provenance is doc-based |
| §6 skill wrappers | high | the `disable-model-invocation` refusal is a doc/patch-header claim; I did not read the refusal site in `tool-skill` |
| §7 memory-evolve | high for packaging, low for runtime | not installed; `lib/store.js` unopened (§7.6) |
| §8 convention | high | "required" sections are a pattern across 7 docs, not a schema |
| §9 gotchas | high | 10 is partly disputed; 6-8/11/15-17 are host-code derived |
| §10 scaffold | medium-high | a synthesis; checklist steps 4-7 need an install + restart, which this task forbade |

### What I did not do / cannot claim

No install, no build, no server start, no restart, and no writes outside
`$PLUG/dsh-cortex/.dev/recon/RECON-EXAMPLES.md`. I did not execute plugin code: every "this
registers X" claim is read out of source or built artifacts (cited), plus indirect runtime
corroboration — the profile's symlink list, the `free-search` / `mnemon` / `ui-theme` namespaces in
`$DSH_HOME/settings.yaml:142,115,144`, and the fact that these plugins' *output text* is present in
my own runtime context: the `webSearch` tool description is free-search's (engine chain,
`free_search_test`, "Current engine: tinyfish"; matches `dsh-free-search-chain/lib/index.js:2291`)
and the "MNEMON RUNTIME MEMORY PROTOCOL" block is mnemon's
(`dsh-mnemon/lib/index.js:2430-2435` carrying
`plugins/dsh-mnemon-strategy-default-three-tier/src/guidance.ts:1-21`). Limitation stated precisely:
those plugin tools are **not exposed to this subagent** (reduced tool set), so this proves mount +
injection, `[verified]` only as observed-in-context, not as a controlled experiment.
`dsh-uipromax-plugin`, `dsh-web-monid*`, `@huanlin/dsh-plugin-session-delete`,
`@ashafizullah/dsh-telegram` and `@xmanrui/dsh-im` were not dissected (outside the assigned list).
`$PLUG/dsh-cortex` contains no plugin code yet — only `.dev/recon/`, shared with two sibling recon
docs (`RECON-SDK.md`, `RECON-SCENARIOS.md`), both of which were still heading stubs when I read
their first 20 lines.

## 1. The active profile: how `link:` plugins are wired

`$PROF` = `/home/administrator/agent-workspace/.dsh/profiles/web`. Confidence: **high** (all read directly).

### 1.1 The four files that matter

| file | role | evidence |
| --- | --- | --- |
| `package.json` | pnpm manifest: `dependencies` carry the real wiring (`link:<abs path>`), `dsh.profile.bundles` is the ordered layer list | `$PROF/package.json:4-41`, `:42-64` |
| `pnpm-workspace.yaml` | `packages: [.]`, `nodeLinker: hoisted`, `autoInstallPeers: false`, plus a **workspace-local pnpm store/cache** because the default store sits on a read-only root fs | `$PROF/pnpm-workspace.yaml:1-12` |
| `cordis.yml` | the composed root entry list — in this profile it is literally `[]` (line 4) with a comment saying "Edit cordis.patch.yml, not this file" | `$PROF/cordis.yml:1-4` |
| `cordis.patch.yml` | the user patch layer, applied **after** every bundle layer | `$PROF/cordis.patch.yml` (285 lines) |

Composition order is documented in the host: "the tree is composed by applying each
bundle's patch list in `dsh.profile.bundles` order over an empty entry list, then the
profile's own patches, then any launcher layers (`--patch` files and flag-derived
patches)" — `$HOST/packages/boot/app-boot/src/profile.ts:7-13`; also restated in
`$PROF/cordis.yml:1-3`.

### 1.2 What a `link:` entry actually looks like

Every local plugin is a plain pnpm `link:` dependency keyed by its **package name**,
value = absolute directory (`$PROF/package.json`):

```json
"dsh-free-search": "link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-free-search-chain",   // :18
"dsh-ihaveadhd-plugin": "link:.../plugins/dsh-ihaveadhd-plugin",                                          // :19
"dsh-mnemon": "link:.../plugins/dsh-mnemon",                                                              // :20
"dsh-mnemon-provider-mem0": "link:.../plugins/dsh-mnemon/plugins/dsh-mnemon-provider-mem0",               // :25
"dsh-session-readcache": "link:.../plugins/dsh-session-readcache",                                        // :35
"dsh-superpowers-plugin": "link:.../plugins/dsh-superpowers-plugin",                                      // :36
"@domitor-syh/dsh-ui-skin-switcher": "link:.../plugins/dsh-ui-skin-switcher",                             // :14
```

Notes:
- The dep key need not match the directory name (`dsh-free-search` → `…/dsh-free-search-chain`,
  `:18`); it must match the plugin's own `package.json` `name`.
- Sub-plugins of a monorepo are linked **individually by subdirectory** (`:21-33`), i.e.
  there is no pnpm workspace at the plugin side doing the linking for the profile.
- Two `link:` deps point into the host checkout itself
  (`@deepseek-ai/dsh-web-search-tinyfish` → `$HOST/packages/web/web-search-tinyfish`, `:13`;
  `dsh-plugin-anti-slop-shadow` → `$HOST/packages/extensions/anti-slop-shadow`, `:34`).
- All 17 linked/installed plugin packages are also listed in `dsh.profile.bundles`
  (`:44-62`), in install order.

### 1.3 How `dsh plugin add link:…` behaves (host code, not folklore)

`dsh plugin --profile <p> <pnpm args…>` is a **thin pnpm forwarder**:
- it inits the profile if `package.json` is missing (`$HOST/apps/cli/src/plugin.ts:120-125`),
- runs `pnpm <args>` with `cwd = profile dir` (`:129-133`),
- rewrites *relative* path specs against the caller's cwd so `add .` cannot self-link the
  profile (`:104-112`); absolute `link:/abs/path` passes through untouched (`:97-99`),
- then on exit code 0 **reconciles** `dsh.profile.bundles` against installed state
  (`:59-91`): a dependency whose package declares `dsh.bundle.patch` is appended
  automatically (`:66-69`); a dependency that no longer resolves as a bundle is spliced out
  (`:78-87`).

Consequences that are load-bearing for a new plugin:
1. **`dsh.bundle.patch` is the bundle switch.** Without it, `add` installs the package but
   it never becomes a layer — the CLI prints
   `warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer`
   (`:70-75`), and the runtime *throws* if such a name is listed by hand:
   `profile bundle … declares no dsh.bundle in its package.json` (`profile.ts:391-394`).
2. `remove <name>` is likewise pnpm-forwarded; reconciliation is what takes the row out of
   `bundles` — which is why the readcache README tells you to double-check `dsh.profile.bundles`
   and restart afterwards (`$PLUG/dsh-session-readcache/README.md:55-61`).
3. Bundles are resolved **from the dsh installation first, then the profile dir**
   (`profile.ts:344-355`); a `link:` plugin resolves through the profile's `node_modules`
   (`$PROF/node_modules` exists, 151 entries — verified by `ls`), which is also where a
   plugin's own runtime deps get hoisted (`nodeLinker: hoisted`, `pnpm-workspace.yaml:4`). At boot
   the profile directory becomes the loader's module base:
   `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'`
   (`$HOST/packages/boot/app-boot/src/index.ts:769`), matching "Relative entry names resolve
   against the config directory; bare package names resolve there by default" (`:729-731`); the
   client registry uses the same anchor ("the config tree's `baseUrl` … whose package declares
   every composed plugin as a dependency", `packages/client/modules/src/index.ts:303-307`).
   **Observed caveat on this machine:** pnpm does not hoist a `link:` dependency's own deps into the
   profile root — `@deepseek-ai/dsh-settings` is absent from `$PROF/node_modules/@deepseek-ai`
   (11 entries, `ls`) and resolves from the plugin's own `node_modules` symlink instead
   (`$PLUG/dsh-free-search-chain/node_modules/@deepseek-ai/dsh-settings ->
   $HOST/packages/settings/settings`, seen with `ls -la`). So a linked plugin that imports anything
   at runtime must also have `pnpm install` run **inside its own directory** (free-search and every
   mnemon sub-package have their own `node_modules/`; readcache and the skill wrappers need none
   because they import only `node:*` or nothing).
4. Git-hosted plugins that build on install hit pnpm ≥10 script blocking; the CLI's hint is to
   add the printed key under `allowBuilds` in the profile's `pnpm-workspace.yaml`
   (`plugin.ts:150-155`). Two profile deps are indeed git specs
   (`$PROF/package.json:15`, `:17`, `:40`).

### 1.4 What the profile patch does (and does not) contain for these plugins

`$PROF/cordis.patch.yml` inserts only non-local rows (mcp-omni `:2`, subagent tools `:53-235`,
`web-search-tinyfish` `:236-237`) and then overrides two rows by id
(`- id: web` → `:273-276`, `- id: tool-web` → `:281-285`). None of the studied local plugins
have an `insert` there, because **the plugin ships its own row** — see the explicit note at
`:259-264`: "the plugin registers ITSELF via its own bundle patch … Do NOT add a second insert
here — duplicate loader id."

## 2. dsh-session-readcache — minimal client+host plugin

Dir: `$PLUG/dsh-session-readcache` (no git dir, no `src/`, no `node_modules/`). Confidence: **high**.

### 2.1 File tree (complete)

```
dsh-session-readcache/
  README.md               61 lines — why/safety/install/config table/tests/rollback
  package.json            35 lines
  cordis.patch.yml        12 lines  (the bundle patch = self-registration row)
  lib/index.js           142 lines  (the ONLY code artifact; hand-written, not bundled)
  tests/logic.mjs        142 lines  (node tests against a fake service)
  tests/realfile.mts      86 lines  (integration probe on a real session.jsonl.zstd)
```

### 2.2 `package.json` `dsh.*` manifest (verbatim, `package.json:27-34`)

```json
  "dsh": {
    "bundle": {
      "patch": "cordis.patch.yml"
    },
    "engines": {
      "dsh": ">=0.1.1-rc.1"
    }
  }
```

Surrounding fields that make it loadable/publishable: `"type": "module"` (`:13`),
`"main": "lib/index.js"` (`:14`), `exports` with **only** `.` and `./package.json` (`:15-18`),
`"files": ["lib/index.js", "cordis.patch.yml"]` (`:19-22`), `engines.node >= 20` (`:24-26`).
There is **no dependency at all** — not even on a plugin SDK. That is the cheapest possible
working manifest.

### 2.3 Entry point structure (host side)

`lib/index.js` is a Cordis-style plugin module: four named exports
`{ apply, inject, name, provide }` (`lib/index.js:142`), with

```js
const name = 'session-readcache'   // :7   loader plugin name
const inject = []                  // :8   nothing needed at mount time
const provide = []                 // :9   provides no service
function apply(ctx, config = {}) { // :30  the entry
```

The interesting part is that it needs **no services at mount**, so it defers:
`ctx.inject(['sessionPersistence', 'sessions'], ({ sessionPersistence: target, sessions }) => {…})`
(`:40`) — service acquisition at runtime, inside `apply`.

It then **monkey-patches a host service instance** rather than registering anything:
`Object.defineProperty(target, 'inspect', { value: inspect, configurable: true, writable: true })`
and the same for `list` plus an idempotency marker `__readcacheApplied`
(`:124-126`, guarded at `:41`). Undo is registered through `ctx.effect`
(`:131-138`), which deletes the own-props and logs hit/miss counters.

### 2.4 Config / defaults declaration

No schemastery here — a plain defaults object plus clamp helpers:

```js
const DEFAULTS = { maxEntries: 24, maxTotalEvents: 250000, listTtlMs: 750 }  // :11
function positiveInt(value, fallback) { … }                                  // :13-15
if (config.enabled === false) { ctx.logger?.info?.('… disabled by config'); return }  // :31-34
```

Defaults are restated in the patch file so the row is self-describing
(`cordis.patch.yml:6-12`), and the patch header documents the kill switch
(`:5` "Set enabled: false to neutralize the row without uninstalling").

### 2.5 Persistence

None. All state is in-process (`Map` + `listCache`, `:44`, `:97-98`); the README says so
explicitly: "If the plugin were removed entirely, behavior reverts to the host's own cache"
(`README.md:22`). Diagnostics go to `process.stderr.write` + `ctx.logger?.info?.`
(`:127-130`) — the only "output" side effect.

### 2.6 Tools / UI registration

None. This is the pure host-side, no-surface baseline.

### 2.7 Build scripts / artifacts the profile loads

**No scripts, no build step**: the profile loads `lib/index.js` exactly as committed, via
`main`/`exports["."]` resolved from `$PROF/node_modules/dsh-session-readcache` (the `link:`).
That is the "hand-write the artifact" strategy: no toolchain, no `lib/` regeneration risk.
`dsh.bundle.patch` → `cordis.patch.yml` is what makes `dsh plugin add` treat it as a layer
(`$HOST/apps/cli/src/plugin.ts:36-45,66-69`).

## 3. dsh-free-search — tool-providing plugin (with settings UI + HTTP bridge)

Dir: `$PLUG/dsh-free-search-chain`, package name `dsh-free-search`, version `0.4.24-chain.1`.
The profile links the directory but refers to it by package name
(`$PROF/package.json:18`, `:55`). Confidence: **high** for observed code; the *TypeScript
source* is not present in the directory (only built `lib/`), so source-level claims are
`[inferred]`.

### 3.1 File tree (complete)

```
dsh-free-search-chain/
  package.json        66 lines
  cordis.patch.yml    24 lines   (self-registration + web override)
  lib/index.js      2355 lines   (host bundle, esbuild-style concatenated output)
  lib/client.js     1015 lines   (client bundle, __ModuleLoader__ IIFE)
  node_modules/                  (the ONLY local plugin here that still has one)
```

### 3.2 `dsh.*` manifest (verbatim, `package.json:52-65`)

```json
  "dsh": {
    "bundle": {
      "patch": "cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime"
      ],
      "platform": "web"
    },
    "engines": {
      "dsh": ">=0.1.1-rc.1"
    }
  }
```

plus `main: "lib/index.js"` (`:6`), `exports` `{ ".", "./client", "./package.json" }` (`:7-11`),
`files: ["lib/index.js","lib/client.js","cordis.patch.yml"]` (`:12-16`),
`dependencies: { "@deepseek-ai/dsh-settings": "link:/home/administrator/deepseek-harness/packages/settings/settings", "@deepseek-ai/schemastery": "^3.18.1" }` (`:42-45`),
`peerDependencies: { "@deepseek-ai/dsh-tools": ">=0.1.0-rc.6" }` (`:46-48`) and
`devDependencies` pinning `0.1.0-rc.7` (`:49-51`) — i.e. **tools come as a peer**, so the
plugin compiles against a version but the profile supplies the real one.
There are **no scripts** (build happens elsewhere).

### 3.3 Host entry point

Same four-export contract, but `inject` is non-empty and there is a `Config` schema:

```js
const name = "web-search-free";   // lib/index.js:1581
const inject = ["web"];           // lib/index.js:1582
function apply(ctx, config) {     // lib/index.js:1617
```

`Config` is a schemastery (zod-shaped) object with per-key `.default()` and
`.role("secret")` for API keys (`lib/index.js:1596-1615`):

```js
const Config = z.object({
  provider: z.string().default("tinyfish"),
  cache: z.boolean().default(true),
  cacheTtl: z.number().default(5),
  keyStorage: z.string().default("credentials"), // credentials | settings
  bingMarket: z.string().default("zh-CN"),
  platforms: z.array(z.string()).default(["github","v2ex","bilibili","reddit","hn","stackoverflow","wikipedia","npm"]),
  tinyfishApiKey: z.string().role("secret"),
  …
});
```

The namespace it owns in the settings store is a constant:
`const FREE_SEARCH_NS = "free-search"` (`:45`) — and `$DSH_HOME/settings.yaml:142-143`
contains exactly `free-search:` / `provider: tinyfish`, proving the section installed and
persisted at runtime.

### 3.4 Tool registration (how a plugin tool reaches the model)

```js
import { defineTool } from "@deepseek-ai/dsh-tools";        // lib/index.js:2
…
ctx.inject(["tools"], (sctx) => {                           // :1992
  sctx.effect(() => {                                       // :1993
    const dispose = sctx.tools.register(defineTool({        // :1994
      name: "free_search_test",                             // :1996
      description: "Test every configured web search engine…",
      parameters: { engines: { type: "array", … }, query: { type: "string", … } },
      output: { schema: { type: "object", … }, render(args, value) { … } },
      async execute(args) { … },
    }));
    return dispose;                                         // (unregister on unmount)
  }, "…");
});
```

Three separate `ctx.inject(["tools"], …)` blocks register three tools
(`:1992`, `:2079`, `:2164`). The registration is **inside `sctx.effect`** so it is disposed on
unmount/reload — the pattern every working plugin repeats.

### 3.5 HTTP route registration

Routes are plain objects handed to the host's `webServer` service:

```js
ctx.inject(["webServer", "settings"], (sctx) => {          // :1887
  sctx.effect(() => {
    const disposers = makeBridgeRoutes(sctx.settings, …)
      .map((route) => sctx.webServer.register(route));      // :1894
    return () => { for (const dispose of disposers) dispose(); };
  }, "free-search: settings bridge");
});
```

Route shape (`:1490-1516`, prefix const at `:46`):
`{ kind: "exact", path: `${BRIDGE_PREFIX}/describe`, handler: async (req, res) => … }`
with a `guard(req,res)` that answers 405 for non-POST and `writeJson(res, code, body)`
(`:1484-1489` region of `makeBridgeRoutes`, defined at `:1279`). Endpoints: `describe`,
`mutate`, `credentials-status`, `credentials-set`, `credentials-unset`, `check-update`,
`update`, `raw-search` (`:1495-1566`) — i.e. the plugin exposes its own settings read/write
API instead of relying on a host UI helper.

### 3.6 Settings-section install (dual-version tolerance)

`lib/index.js:1853-1885` — feature-detects `sctx.settings.installSection(ctx, NS, Config,
config, { setSource, onChange })` (newer `dsh-settings`) and falls back to a dynamic
`import("@deepseek-ai/dsh-settings")` + `installSettingsSection` + `settingsNamespace`
(rc.2), warning if neither exists (`:1880`).

### 3.7 Client entry point + settings panel

`lib/client.js` is not ESM: it is a loader registration
(`client.js:1-5`): `window.__ModuleLoader__.load({ id: "dsh-free-search", factory: (require) => { …
let react = require("react"); let react_jsx_runtime = require("react/jsx-runtime"); … } })`
with the CSS shipped as a JS string array (`:11-14`). This matches the host contract in
`$HOST/packages/client/modules/src/index.ts:241-273` (boot queue + `__ModuleLoader__`).

Panel + slash command registration:

```js
const inject = ["slots", "commandUi"];                      // client.js:962
function apply(ctx) {                                        // :964
  ctx.slots.inject("settings.plugin.item", () =>             // :967
    ctx.slots.register({ name: "settings.plugin.item", key: "free-search",
      id: "dsh-free-search", order: 120, inject: () => ({}) }, FreeSearchCard));
  ctx.inject(["commandUi"], (sctx) => { … command.register({ name: "free-search-engine",
    ui: { kind: "popupSelect", options: async () => …, onSelect: … } }) … });   // :981-1008
}
```

The `settings.plugin.item` slot is declared `kind: 'keyed'` by the host
(`$HOST/packages/client/ui-settings-plugins/src/client/slot-contract.ts` — the
`interface SlotMap` merge), which is why `key` is required there.

### 3.8 Persistence

No files of its own: config persists through the host settings store (`free-search:` in
`settings.yaml:142`), secrets through the credentials center
(`keyStorage: "credentials"` default, `lib/index.js:1600`, ref whitelist map at `:1585-1594`).
Runtime cache is an in-memory `Map` with TTL + LRU-ish eviction (`:1823-1838`,
`CACHE_MAX_ENTRIES = 50` at `:167`).

## 4. dsh-mnemon — the largest working example (monorepo, 1 root bundle + 16 sub-packages)

Dir: `$PLUG/dsh-mnemon` (real git repo, `.git/`, changesets, CI, 659 KB lockfile).
Confidence: **high** — this one ships TypeScript source at root (`src/{client,core,host,sdk}`,
`scripts/`, `tests/`, `tsconfig.json`, `tsdown.config.ts`) as well as built `lib/`, so claims
below cite `src/` where possible and built `lib/` where that is all there is.

### 4.1 Top-level tree (depth 1-2, trimmed)

```
dsh-mnemon/
  package.json          213 lines  root bundle manifest
  cordis.patch.yml       90 lines  THE composition file: one cordis:group with 11 child rows
  pnpm-workspace.yaml  ~11.5 KB    workspace definition (sub-packages)
  .gitignore              12 lines  ← /lib/ and /plugins/*/lib/ are IGNORED
  README.md / README.zh-CN.md      (12 KB each)
  CONTRIBUTING.md, SECURITY.md, ISSUE_TRIAGE.md, THIRD_PARTY_NOTICES.md
  docs/{en,zh-CN}/{guides,reference,development,releases,roadmap}
  lib/{index,core,client,contracts,extension-sdk,testing}.js + chunk files + types/
  plugins/dsh-mnemon-{provider-*×9, source-*×3, strategy-*×4}
  .changeset/ .github/ scripts/ tests/ (per root scripts)
```

### 4.2 Root `dsh.*` manifest (verbatim, `package.json:102-116`)

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-locale"
      ],
      "platform": "web"
    }
  }
```

Export map publishes six entry points (`.`/`./core`/`./client`/`./contracts`/
`./extension-sdk`/`./testing`, `:66-92`) — the **extension-sdk** subpath is how sub-plugins
import the parent's contract API (`plugins/dsh-mnemon-strategy-default-three-tier/src/index.ts:2`
imports `defineMemoryPlugin, installMemory, defineMemoryStrategyConfiguration` from
`dsh-mnemon/extension-sdk`).

Build/verify scripts (`package.json:117-139`) — this is the heavyweight reference toolchain:

```json
"build": "tsdown && tsc -p tsconfig.types.json && node scripts/link-bundle-declarations.mjs",
"bundle": "tsdown",
"verify": "pnpm run verify:docs && pnpm run typecheck && pnpm run verify:build && pnpm --workspace-concurrency=4 -r build && pnpm -r typecheck && pnpm -r test && pnpm run test:root && pnpm run verify:headless && pnpm run verify:package",
"verify:build": "node scripts/verify-deterministic-build.mjs",
"verify:plugins": "node scripts/verify-plugin-artifacts.mjs",
"dsh:link-source": "node scripts/link-dsh-source.mjs",
"dsh:restore-registry": "node scripts/link-dsh-source.mjs --restore",
```

`verify` runs `pnpm -r build` across the workspace (`:131`) — i.e. **every sub-plugin's
gitignored `lib/` must be rebuilt** after a fresh clone; and there is an explicit script pair
for swapping the host SDK between the registry copy and a local harness checkout
(`dsh:link-source` / `dsh:restore-registry`, `:136-137`).

### 4.3 Composition: one row mounts the whole fleet (`cordis.patch.yml:4-16,50-90`)

```yaml
- insert:
    - id: mnemon-bundle
      name: cordis:group          # host builtin supplied by boot()
      group: true
      disabled: !!js >-           # computed from the user's `mnemon` row
        ((entry) => entry.options.disabled?.__jsExpr
          ? Boolean(entry.evaluate(entry.options.disabled.__jsExpr))
          : Boolean(entry.options.disabled))
        ([...loader.entries()].find(entry => entry.options.id === 'mnemon'))
      config:
        - id: mnemon
          name: dsh-mnemon
          config: { … 15 knobs, see below … }
        - id: mnemon-source-runtime
          name: dsh-mnemon-source-runtime
        …
        - id: mnemon-strategy-scoped
          name: dsh-mnemon-strategy-scoped
          disabled: true          # opt-in
```

Facts proven here:
- **`cordis:group` + `group: true` nests child entries under one parent**, so a monorepo ships
  one parent bundle and mounts all sub-plugins from it (`:9-16`, children `:18-90`). The
  builtin is registered by `boot()`, not by the plugin
  (`$HOST/packages/boot/app-boot/tests/config-reload.spec.ts:221,258,392`).
- **`!!js` in a patch file becomes `{ __jsExpr: <source> }`** and is evaluated by the loader —
  `$HOST/vendor/include/src/index.ts:12-14` (construct/represent) and
  `packages/bundle/base/tests/base.spec.ts:69` for the evaluate pattern.
- **A parent patch can disable every child from one place** by reading the parent row's own
  flag (comment at `:5-8`: reads the *declared* flag to avoid recursing through its own gate).
- Sub-packages do **not** need their own patch to be mounted: `dsh-mnemon-source-runtime` has
  `dsh.client` but **no `dsh.bundle`** (its `package.json` shows only the `client` block) and is
  mounted by name from the parent group. Conversely `dsh-mnemon-strategy-scoped` has its own
  `dsh.bundle.patch` + `files: ["lib","cordis.patch.yml","README.md"]` so it can also be added
  standalone. `dsh-mnemon-provider-mnemon-native` has **no `dsh` section at all** — it is a
  plain library selected by name from config
  (`providers: [{ use: dsh-mnemon-provider-mem0, instanceId: mem0 }, …]`, `:59-77`).
- The profile additionally `link:`s each sub-package
  (`$PROF/package.json:21-33`) so they resolve locally instead of from npm
  (root `dependencies` pin them at published `0.5.4`, `package.json:141-156`).

### 4.4 Host entry (`lib/index.js`)

```js
const name = "dsh-mnemon";                                     // :8698
const provide = ["mnemonMemory"];                              // :8699
const inject = ["tools","settings","commands","agents","subagents"];  // :8700-8706
function apply(rawContext, config = {}) { … }                   // :8716
export { Config, apply, inject, name, provide };                // :8822 (last line)
```

- Config schema at `lib/index.js:168` (`const Config = z.object({…})`), defaults additionally
  restated in the group row (`cordis.patch.yml:21-49`) — the shipped pattern is *both*: schema
  defaults + explicit patch values, so `--dump-config` is self-documenting.
- 15 × `ctx.tools.register(...)`; tool names surface to the model verbatim
  (`grep` of `lib/index.js` → `mnemon_recall`, `mnemon_remember`, `mnemon_runtime_memory`,
  `mnemon_document_search`, `mnemon_document_manage`, `mnemon_forget`, `mnemon_link`,
  `mnemon_memory_bodies`, `mnemon_memory_body_create|merge|update`, `mnemon_related`,
  `mnemon_status`, `mnemon_view_action`, `mnemon_view_route`).
- Tool shape (richer than free-search's): `ctx.tools.register(definition({ name, description,
  parameters: <full JSON Schema with required:>, output: { schema, render, presentationMeta },
  execute: async (args, exec) => …(exec.signal), presentCall, presentResult }))`
  (`lib/index.js:6742-6780`) — `presentCall/presentResult` control the conversation tool card.
- **Optional services are fetched lazily, never injected**: `optionalWorkspaceRegistry(ctx)`
  wraps `ctx.get("workspaceRegistry")` with a `?.` fallback because the Web workspace service
  may not exist in a headless profile (`lib/index.js:8707-8714`).

### 4.5 Turn-context injection (the mechanism a context-injecting plugin needs)

Two mechanisms are in use:

1. **Prompt section** (static-ish, ordered, reactive):
   `ctx.get("systemPrompt")?.section?.({ name: GUIDANCE_SECTION_NAME, order: 150, text: () => … })`
   (`lib/index.js:2430-2435`) — host-native form is `ctx.systemPrompt.section({ name, order,
   text })` where `text` may be a function of a scope context and empty strings are omitted:
   `$HOST/packages/fs/tool-fs/src/read.ts:70-74` and
   `$HOST/packages/subagent/tool-subagent/src/index.ts:470-476`.
2. **Per-step message injection** (dynamic, durable, attributed): the in-box
   `time-context` plugin registers `ctx.on('agent/pre-step', async ({ agent, turn, step, signal },
   next) => { … return { kind: 'enter', messages: [...decision.messages, createUserMessage({
   content: [{type:'text', text}], source: { kind: 'plugin', plugin: name, form: 'snapshot',
   sections: [{ name, text }] } })] } }, { prepend: true })`
   (`$HOST/packages/context/time-context/src/index.ts:145-209`, hook at `:170-173`, append at
   `:198-208`, options at `:208`). Its config contract is the canonical TS shape:
   `export const name/inject/Config interface + z.object(...)` (`:21-38`).
3. Mnemon also **rewrites an assembled section list** rather than only appending one:
   `return withoutMemoryViewContext({ ...assembly, sections })` (`lib/index.js:2425-2429`), and
   its per-turn text lives in a plain string module
   (`plugins/dsh-mnemon-strategy-default-three-tier/src/guidance.ts:1-39`) — the exact
   "MNEMON RUNTIME MEMORY PROTOCOL" block a session sees in its system prompt.

### 4.6 Client surfaces (settings page + session tab)

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "mnemon", order: 20,
  label: () => translate("tab.label"), locale: namespace,
  inject: () => ({ scope: settings, connection: ctx.connection, sessionId, t: translate }),
}, …Component…));                                              // lib/client.js:8263-8289

const disposeView = ctx.slots.inject("conversation.view", () => ctx.slots.register({
  name: "conversation.view", id: "mnemon", order: 30,
  label: () => translate("tab.label"), locale: namespace,
  children: { "mnemon.source.page": { kind: "list", scope: "root" } },   // declares a nested slot
  inject: (sessionId) => ({ connection: ctx.connection, settingsScope: settings,
    sessionId, localeRuntime: ctx.locale, sourcePageDirectory, t: translate }),
}, MnemonBuiltinWorkspaceHost));                               // lib/client.js:8199-8217
```

`conversation.view` is *the* session-tab slot ("one list entry per view tab … rendered
one-at-a-time by the session body via `only: <active id>`" —
`$HOST/packages/client/ui-conversation/src/client/contract/slots.ts`). Settings pages use
`settings.section` (`kind:'list'`, `$HOST/packages/client/ui-settings/src/client/contract/slots.ts`).

A settings-driven mount/unmount pattern is worth copying: `reconcileMemoryWorkspace()` compares
the live settings snapshot to what is mounted, disposes, re-mounts, and subscribes inside
`ctx.effect` (`lib/client.js:8243-8262`).

### 4.7 Persistence (paths)

Documented storage root layout (`docs/en/reference/storage-model.md:42-58`):

```
<storageRoot>/
  runtime/{memories.json,USER.md,MEMORY.md}
  documents/{index.json,active/,archived/}
  data/{.dsh-memory-bodies.json,<space-id>/mnemon.db}
  state/memory-providers.json      # 0600, excluded from packs
```

- `storageScope` picks the root; `workspace` = `<workspace>/.mnemon` per registered DSH
  workspace (`storage-model.md:60`, and `.mnemon/` is gitignored at `.gitignore:10`).
- `memories.json` is the single source of truth; `USER.md`/`MEMORY.md` are deterministic
  projections separated by a standalone `§` line, repaired from JSON at startup
  (`storage-model.md:75-88`).
- Branch scoping is an entry field (`branches`, `target=memory` only) that filters *the prompt
  projection only*, never the files (`storage-model.md:69,86-88`); record fields are
  `content/created_at/updated_at/target/importance/branches` (`:77-84`).
- Size caps: USER.md 4 KiB, MEMORY.md 10 KiB, 8 KiB per item (`:99-104`) — matching the
  `runtimeMemory.{userLimitBytes,memoryLimitBytes}` config in the patch
  (`cordis.patch.yml:35-38`).
- Runtime state proof: `$DSH_HOME/settings.yaml:115-140` holds a real `mnemon:` namespace block
  (persistenceStrategy/provider/rules/embedding…), written by the plugin's settings section.

### 4.8 Docs discipline worth stealing

`docs/en/development/extensions.md:90` tells third parties exactly what an external plugin must
declare: verify `peerDependencies` **and `dsh.bundle.patch`**, then "activate it explicitly in
Profile composition after restarting — Downloading an npm package is not activation, and Mnemon
does not hot-load it into the current process." Install/rollback commands (`link:` form included)
are in `docs/en/guides/getting-started.md:105-143`, and the "plugins are profile-local" gotcha is
called out in the troubleshooting table (`docs/en/guides/operations.md:224`).

### 4.9 Build toolchain (`tsdown.config.ts`, the recipe to copy)

Two faces from one config file:

```ts
const host: UserConfig = {                     // tsdown.config.ts:19-34
  name: PLUGIN_ID, entry: { index: 'src/index.ts', core: 'src/core/plugin.ts',
    contracts: 'src/core/contracts/index.ts', 'extension-sdk': 'src/sdk/index.ts',
    testing: 'src/sdk/testing.ts' },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: true, deps: { neverBundle: true },
}
const client: UserConfig = {                   // :36-61
  name: `${PLUGIN_ID}/client`, entry: { client: 'src/client/index.ts' },
  outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022',
  clean: false, sourcemap: false,
  deps: { neverBundle: CLIENT_EXTERNALS,        // :10-15 react, react-dom, cordis, dsh-client-ui-primitives
          alwaysBundle: [/^dsh-mnemon-source-[^/]+\/presentation\//] },  // :50
  outputOptions: {                              // :56-60  ← this trio IS the client contract
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
  plugins: [clientCssPlugin()],                 // :63+ lightningcss → CSS inlined as a string +
}                                               // <style data-plugin-css=…> tag (:89-95)
```

`src/index.ts:1` re-exports the host face:
`export { name, inject, provide, Config, apply } from './host/plugin.ts'`.
The in-box equivalent of this hand-rolled config is the shared preset
`clientBundle(id, …)` (`$HOST/packages/client/tsdown.client.ts:106`; its JSDoc `:1-10` states the
same artifact contract), but that preset lives in the harness repo and is imported relatively
(`:18-20`), i.e. not consumable from an external package — `[inferred]`.

## 5. dsh-ui-skin-switcher — UI customization (client-first plugin, forked from in-box code)

Dir: `$PLUG/dsh-ui-skin-switcher`; package `@domitor-syh/dsh-ui-skin-switcher@0.1.0`,
publishable (`publishConfig.access: public`, `package.json:5-7`). Confidence: **high**
(has both `src/` and `lib/`).

### 5.1 Tree (depth 2)

```
dsh-ui-skin-switcher/
  package.json 78 lines · cordis.patch.yml 9 lines · LICENSE
  README.md 639 B · README.fork.md 9.5 KB (fork provenance + string table)
  src/{index.ts 9, invariant.ts 31, client/index.ts 475}
  lib/{index.js 11, invariant.js 24, client.js 450, types/{index,invariant}.d.ts, types/client/}
  (../dsh-ui-skin-switcher-upstream/ = upstream clone @ 2d47af2, kept for rebase;
   ../.rollback-skin-switcher/npm-pristine/ = untouched npm artifact for diffing)
```

### 5.2 Manifest highlights

- `dsh.bundle.patch: "./cordis.patch.yml"` + `dsh.client.inject` = three client packages
  (`connection`, `ui-conversation`, `ui-slots`) and `platform: "web"` (`package.json:32-44`).
- Everything DSH-specific is `peerDependencies` and mirrored in `devDependencies` (`:46-66`) —
  so it builds standalone and runs against the host's copies.
- `exports` follows the in-box convention `.` / `./invariant` / `./client` / `./src/*` /
  `./package.json` with `types` conditions (`:16-31`); `files` ships `lib/*` +
  `lib/types/**/*.d.ts` + the patch (`:67-73`). Scripts are only `bundle: "tsdown"` and
  `watch: "tsdown --watch"` (`:74-77`) — and **there is no `tsdown.config.ts` in the fork
  directory** (verified by `find … -maxdepth 2`), so `lib/` came from the installed npm artifact,
  not from a local build. `dsh-ui-skin-switcher.local-link.md:55-61` explains why: the GitHub
  repo's prebuilt `lib/` hashes differently from the npm tarball's on all three files, and only
  the npm one was audited.

### 5.3 Host half of a pure-UI plugin

`src/index.ts:1-9` — the entire node face:

```ts
/** Skin-switcher plugin, node half. Pure UI plugin: the empty apply exists so
 * the plugin appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"], discovered through the package.json dsh.client declaration. */
export function apply(): void {}
```

`lib/index.js:9-11` confirms the built form is `function apply() {}` + `export { apply }`.
`src/invariant.ts` is the optional companion (`name`, `inject: ['invariants']`,
`ctx.invariants.register(PACKAGE_NAME, install)`, `:13-30`) — in-box convention, skippable.

The row that makes the client discoverable (`cordis.patch.yml:7-9`):

```yaml
- insert:
    - id: ui-skin-switcher
      name: '@domitor-syh/dsh-ui-skin-switcher'
```

No `config:` at all — the minimum viable self-mount.

### 5.4 Client half: replacing a first-party seat + CSS

```ts
export const inject = ['connection', 'sessions', 'slots']   // src/client/index.ts:15
function injectCss(css: string): () => void {                // :18-26  returns a disposer
  const tag = document.createElement('style'); tag.dataset.plugin = 'skin-switcher'
  tag.textContent = css; document.head.appendChild(tag); return () => { tag.remove() }
}
export function apply(ctx: any): void {                      // :111
  const api = ctx.connection.api.sessions as { models: …, selectModel: … }   // :112-115
  ctx.effect(() => injectCss(CSS))                           // :120
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register(
    { name: 'conversation.input.model', priority: -1 },      // :122-123 wins the 'single' seat
    (props: any) => { const { locked, sessionId } = props … },
  ))
}
```

Two reusable facts: host session RPC is `ctx.connection.api.sessions.<method>({sessionId,…})`
returning `{ ok, value | error }` (`:145-152`), and a `single`-kind seat is *replaced* by
registering into it (here with `priority: -1`), whereas additive seats are `list`/`keyed`
(compare free-search's `settings.plugin.item` + `key`, §3.7, and mnemon's
`settings.section` / `conversation.view`, §4.6). The plugin honours the host's lock state
(`disabled: locked || busy || current === null`,
`dsh-ui-skin-switcher.local-link.md:233`).

### 5.5 Persistence

None of its own; per-model effort memory lives in a module-level `Map` and is lost on reload
(`dsh-ui-skin-switcher.local-link.md:228`), and there is **no settings row** — the only lever is
the host's per-model `reasoningEfforts` declaration (`:231-232`).

## 6. Skill-wrapper plugins — the zero-code bundle

`$PLUG/dsh-ihaveadhd-plugin` and `$PLUG/dsh-superpowers-plugin`. Confidence: **high**.

### 6.1 Trees

```
dsh-ihaveadhd-plugin/  package.json (12 lines) · cordis.patch.yml (18) · README.md (39)
                       skills/i-have-adhd/{SKILL.md, LICENSE}
dsh-superpowers-plugin/ package.json (12 lines) · cordis.patch.yml (14)
                       ← NO skills/ dir: it points at ../dsh-superpowers/skills
```

### 6.2 Manifest (verbatim, `dsh-ihaveadhd-plugin/package.json:1-12`)

```json
{
  "name": "dsh-ihaveadhd-plugin",
  "version": "0.1.0",
  "private": true,
  "description": "DSH wrapper: exposes vendored i-have-adhd skill (upstream ayghri/i-have-adhd @ 6f1f982d, v0.3.0, MIT) via an isolated dsh-skill-filesystem instance (Cara A).",
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

No `main`, no deps, no scripts, no client block: `private: true` + `dsh.bundle.patch` is the
whole contract for a config-only bundle.

### 6.3 The payload is a patch that mounts *another* plugin with its own id

```yaml
# dsh-ihaveadhd-plugin/cordis.patch.yml:11-18
- insert:
    - id: ihaveadhd-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: ihaveadhd
        includeDefaultRoots: false
        customSkillDirs:
          - /home/administrator/agent-workspace/dsh-custom/plugins/dsh-ihaveadhd-plugin/skills
```

```yaml
# dsh-superpowers-plugin/cordis.patch.yml:7-14 — same plugin package, different id + providerName
    - id: superpowers-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config: { providerName: superpowers, includeDefaultRoots: false,
                customSkillDirs: [ …/dsh-superpowers/skills ] }
```

Host-side support for those keys is real: `providerName`/`includeDefaultRoots`/`customSkillDirs`
are declared and defaulted in `$HOST/packages/skill/skill-filesystem/src/index.ts:49-89`
(`providerName: z.string().min(1).default('filesystem')`, `includeDefaultRoots.default(true)`,
`customSkillDirs.default([])`; roots are `resolve()`d at `:165`).
**Multiple rows of one plugin package are legal** — the row `id` distinguishes them (the module
exports a single `name = 'skill-filesystem'`, `:45`), which is exactly the "duplicate loader id"
trap in §9.

### 6.4 Skill content caveats (empirically found, documented in-repo)

- `disable-model-invocation: true` must be **removed** from vendored `SKILL.md` frontmatter:
  DSH's skill tool refuses to load such a skill ("not available for model invocation") and the
  skill tool is the only formal invocation path
  (`dsh-ihaveadhd-plugin/cordis.patch.yml:6-10`; restated in `README.md:20-26`).
- The routing `description` was rewritten from Claude-Code `/command` phrasing because DSH routes
  from the catalogue description (`README.md:20-23`).
- Upstream execution code (hooks/adapters/scripts) is deliberately **not** vendored — attack
  surface stays zero (`README.md:28-33`); re-vendor is a manual diff (`:35-39`).
- Frontmatter shape in use: `name`, `description`, `license`, `metadata.tags`,
  `metadata.category` (`skills/i-have-adhd/SKILL.md:1-8`).

## 7. dsh-memory-evolve — third-party bundle packaging mechanics (reference for "ready on install")

Dir: `$PLUG/dsh-memory-evolve` (git repo, Chinese docs; **we will not install it** — its
mechanics are the reference). Confidence: **high** for packaging; its runtime claims are
`[unverified-claim]` beyond what its code shows.

### 7.1 Tree (depth 1, trimmed)

```
dsh-memory-evolve/
  package.json · cordis.patch.yml (10 lines) · .gitignore (6 lines — does NOT ignore lib/)
  README.md · README.en.md · README-详细说明.md · LICENSE
  docs/{CHANGELOG.md,CHANGELOG.en.md,rules.md,记忆同步.md,COI-调度.md,images/}
  lib/{index.js 2296, client.js, api.js, memory-tab.js, store.js, review.js, prompts.js,
       prompts-seed.json, models.js, canvas.js, bookmarks.js, session-orch.js, skills*.js,
       advisor/, coi/, search/, sync/, aliases.js, i18n.js, notify*.js}
  scripts/{build.mjs 103, sync-worker.mjs}
  (no src/ in this checkout — lib/ IS the committed artifact)
```

### 7.2 Manifest (the packaging contract, `package.json` via `node -e`)

```json
"main": "lib/index.js",
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
"scripts": { "test": "node --test 'tests/*.test.js'", "build": "node scripts/build.mjs" },
"dsh": {
  "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" },
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

No `dependencies` at all ("the plugin package itself has zero runtime dependencies",
`scripts/build.mjs:10-11`) and **no `files` array** — everything in the package ships.

### 7.3 Install UX = one patch, zero manual config (`cordis.patch.yml:1-10`)

```yaml
# dsh-memory-evolve bundle patch: inserts the host row into the profile's
# plugin roster. The browser half rides the package's `dsh.client` manifest
# (the client registry serves lib/client.js), and this row materializes the
# memory / skills / todos / CLI-dispatch host plugin on boot.
# Install with `dsh plugin --profile <name> add <path-or-git-url>`; the bundle
# patch is applied automatically, so do NOT insert this row again in the
# profile patch (duplicate ids crash the loader).
- insert:
    - id: dsh-memory-evolve
      name: 'dsh-memory-evolve'
```

README restates the user-visible contract: "bundle ships `cordis.patch.yml`
(`dsh.bundle.patch` declared), after `dsh plugin add` the **host side self-registers, no manual
config at all** — two steps", i.e. `dsh plugin --profile web add github:csyangwen/dsh-memory-evolve`
then restart (`README.md:13-19`), and uninstall auto-cleans (`README.md:42`). After an update:
"must restart `dsh web` and then refresh the browser (a page refresh alone will not load new
code)" (`README.md:304`).

### 7.4 The two registration patterns worth stealing (its host half)

```js
export const inject = ['tools','systemPrompt','agents','sessionTitle','sessionPersistence','settings','llm']  // lib/index.js:73
ctx.effect(() => ctx.tools.register(memoryTool(...)), 'dsh-memory-evolve: memory tool')                        // :1710
ctx.effect(() => ctx.systemPrompt.context({                                                                     // :1684
  name: 'memory:snapshot',
  order: config.snapshotOrder,
  text: (context) => renderSnapshot(runtime, store, context.agent, counter, ctx.sessionTitle, writeGap),
}), 'dsh-memory-evolve: memory snapshot')                                                                       // :1706
return ctx.webServer.register({ kind: 'prefix', path: '/memory-evolve', handler })                              // lib/api.js:846
```

- `systemPrompt.context()` (dynamic, per-assembly, `text(context)` sees
  `context.agent`) vs `systemPrompt.section()` (static-ish prompt body): both are declared in
  `$HOST/packages/core/system-prompt/src/index.ts:53-84`, names must be unique
  ("a duplicate registration throws", `:54`), ordering convention is documented at `:56-61`
  (`-100` harness identity, `0` persona, tool guidance `100-199`), and `AssembleContext` is
  merge-extended with `agent?: Agent` by `$HOST/packages/core/agent/src/runtime-types.ts:16-21`.
- A **prefix route** (`kind:'prefix'`) lets one handler serve an entire `/memory-evolve/api/*`
  namespace instead of enumerating exact paths (contrast free-search's `kind:'exact'` rows, §3.5).
- Feature-flag `sync()` controllers: config changes at runtime call `modelsCtrl.sync()`,
  `uiSettingsCtrl.sync()`, `bookmarkCtrl.sync()`, `advisorCtrl.sync()` etc. to install/uninstall
  sub-surfaces without remounting (`lib/index.js:1670-1676`).
- **Idempotency guard against a host quirk**: it catches `already registered` and returns a
  no-op disposer, because "DSH 0.1.x's loader once assembled a plugin twice on a scope-less ctx"
  (`lib/index.js:1694-1705`, their issue #23).

### 7.5 The client build contract, spelled out (`scripts/build.mjs`)

```js
const PLUGIN_ID = MANIFEST.name            // :36-37  ← loader entry id must equal package name
const EXTERNALS = ['react','react/jsx-runtime','react-dom','react-dom/client','cordis',
  '@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client']            // :40-51
const banner = [`window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
                'var module = { exports: {} }; var exports = module.exports;'].join('\n')  // :71-74
const footer = 'return module.exports; } });'                                              // :75
await esbuild.build({ entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js',
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', external: EXTERNALS,
  define: { 'process.env.NODE_ENV': '"production"' } })                                   // :85-94
```

The comment at `:26-35` is the single most useful install-mechanics sentence found anywhere:
since the standard `dsh plugin --profile <name> add <pkg>` install (packages land in the
profile's `node_modules`), **`client-modules` resolves the client bundle's registration id from
the loader entry's `name`, which is the package.json `name`**; the older mechanism
(`~/node_modules/@dsh-local/` symlink + `~/.dsh/config.yaml`) is deprecated and
`config.yaml` is no longer read — hard-coding the old prefix yields
`"loaded without registering"` (their issue #3). `[verified]` as a doc claim; the `name` half is
independently confirmed by `$HOST/packages/client/modules/src/index.ts:484` (`entry.options.name`)
and `:451-456` (`exports["./client"]` → served file).

The authoritative platform-module table an external may `require()` is
`$HOST/packages/client/web/src/seed.ts:26-34`: `react`, `react/jsx-runtime`, `react-dom`,
`react-dom/client`, **`@deepseek-ai/cordis`** (not bare `cordis`),
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, plus
`@deepseek-ai/dsh-client-runtime/client` preloaded
(`$HOST/packages/client/web/src/platform.ts:8-17`). `[inferred]`: memory-evolve's extra externals
(`dsh-client-web-react`, `dsh-client-schema-form`) must come from mounted plugin rows, so
requiring them couples you to another plugin being present.

### 7.6 Its persistence (what "ready on install" must not break)

Data lives behind `lib/store.js` with a `memory-bodies`-style file layout and `store.entryIdMode`
switching (`lib/index.js:1673`), i.e. an own-directory scheme rather than the host settings store
for content, while *config* uses the injected `settings` service
(`inject` list at `:73`). `[inferred]` for the exact root path — I did not open `lib/store.js`.

## 8. The `.local-link.md` documentation convention

Files found: `$PLUG/{dsh-session-readcache,dsh-ui-skin-switcher,dsh-mnemon,dsh-ihaveadhd-plugin,dsh-superpowers-plugin,dsh-uipromax-plugin,dsh-memory-evolve}.local-link.md`
— siblings of the plugin directories (not inside them), mode `-rw-------` (0600), sizes
110-833 lines. Read in full: `dsh-session-readcache.local-link.md` (121 lines) and
`dsh-mnemon.local-link.md` (833 lines, structure sampled); headings extracted for the other five.
Confidence: **high** for the pattern, `[inferred]` for the "required" label — the host has zero
references to the string `.local-link.md` (verified by `grep -rn "local-link"` over
`$HOST/packages` + `$HOST/apps`: no hits), so it is a **human/agent convention of this
workspace, not a host feature**. Nothing validates it; its value is that every one of the seven
local plugins has one and they follow the same skeleton.

Language: Indonesian prose with English identifiers/commands ("Cara A" = option A,
"terverifikasi" = verified, "sudah dijalankan" = already executed, "Keterbatasan" = limitations).

### 8.1 Required sections (union of the five small docs + the runbook variant)

| # | Section | What it contains | Evidence |
| --- | --- | --- | --- |
| 0 | `# <Plugin> — Local Plugin, Link, dan Status Verifikasi` | title naming the fork/wrapper role | `dsh-session-readcache.local-link.md:1`, `dsh-ui-skin-switcher.local-link.md:1`, `dsh-mnemon.local-link.md:1` |
| 0b | Identity paragraph + provenance | what it is, upstream repo/pin (`ayghri/i-have-adhd @ 6f1f982d, v0.3.0, MIT`), **Dibuat:** date, **Status:** bold one-liner stating install state and *how* it was verified (live vs isolated smoke-boot vs not yet restarted) | `dsh-session-readcache.local-link.md:3-9`, `dsh-ihaveadhd-plugin.local-link.md:1-13`, `dsh-ui-skin-switcher.local-link.md:11-14` |
| 1 | `## 1. Layout` | the file tree (fenced or a role→path table) incl. the rollback/upstream sibling dirs | readcache `:13-25`, skin `:18-38`, ihaveadhd `:14-29` |
| 2 | `## 2. …` **Patch terhadap upstream / Isi Patch / Apa yang dibungkus dan kenapa** | exactly what differs from upstream (literal string tables, frontmatter edits) **with measured diff shape** ("6 hunk / 11 pasangan baris / 22 baris") and why the design is what it is | skin `:40-53`, readcache `:27-41`, ihaveadhd `:30-56` |
| 3 | `## … Kontrak & batasan` (optional but present where the host API fought back) | verified host constraints that shaped the implementation, cited to host/vendor `file:line` | readcache `:43-56` (cites `vendor/cordis/src/fiber.ts:51-53`) |
| 4 | `## 4. Pemasangan / Install (yang sudah dijalankan)` | the exact commands run, plus profile-manifest snippets, and any CLI gap discovered | readcache `:58-74`, skin `:29-38`, ihaveadhd `:57-64`, mnemon `#8-#11` |
| 5 | `## … Verifikasi Statik` | gates run *before* installing (node --check, md5 comparisons, CJK counts, JSON/YAML parse of the profile manifest) | skin `:63-82`, superpowers `:49-59`, uipromax `:61-73` |
| 6 | `## … Verifikasi Runtime` | post-restart proof: log lines seen, tools present, "live tanpa restart" caveats, dated | readcache `:91-101`, ihaveadhd `:81-92`, superpowers `:74-88` |
| 7 | `## Keterbatasan yang diketahui` | known limits, incl. upstream health stats ("1 bintang, 1 maintainer, 11 commit, tanpa test"), non-durable state, subagent gaps | skin `:224-235`, ihaveadhd `:93-104`, memory-evolve `:102-116` |
| 8 | `## Update & Revert` | numbered re-apply procedure after an upstream bump; full rollback commands (`pnpm remove` / `dsh plugin … remove`, restore from `.rollback-*` snapshot, verify `dsh.profile.bundles`, restart) | skin `:204-222`, readcache `:112-121`, superpowers `:97-109` |
| — | Open questions section (only when install was staged, not run): "Yang MASIH TERBUKA (jangan dianggap lolos)" | memory-evolve `:102-116` |

Two workspace-wide habits encoded in these docs: (a) every install keeps a
`$PLUG/.rollback-<name>/` snapshot of the profile's `package.json`/`cordis.yml`/
`cordis.patch.yml`/`pnpm-lock.yaml` because **`.dsh` is not git-tracked**
(skin `:25-26,220-222`), and (b) verification is claimed with dates and a stated method, and
"README claim" is explicitly downgraded to non-evidence
(`dsh-memory-evolve.local-link.md:40` "Gerbang yang sudah ditutup (terukur, bukan klaim README)").

## 9. Known gotchas (observed in code or stated in the local docs)

Confidence: **high** — each item is anchored to a line I read. Items marked `[disputed]` carry a
conflict between doc and source; both are cited.

1. **`lib/` is a build artifact and is gitignored.** `$PLUG/dsh-mnemon/.gitignore:3-4`
   (`/lib/`, `/plugins/*/lib/`) and the runbook says raw clone ⇒ unusable because
   `"main": "lib/index.js"` (`dsh-mnemon.local-link.md:53-60`).
2. **Root `pnpm build` is NOT enough for a monorepo** — "pnpm build di root **tidak cukup**
   untuk membangun seluruh child packages… gunakan `pnpm -r build`"
   (`dsh-mnemon.local-link.md:45-51`); the root `verify` script itself runs
   `pnpm --workspace-concurrency=4 -r build && pnpm -r typecheck && pnpm -r test`
   (`dsh-mnemon/package.json:131`). Mnemon also keeps `verify-plugin-artifacts.mjs`
   (`:128`) to prove every sub-package's `lib/` exists.
3. **Duplicate loader id crashes or silently wins the wrong row.** Three independent warnings:
   profile patch says "Do NOT add a second insert here — duplicate loader id"
   (`$PROF/cordis.patch.yml:259-264`); the free-search patch adds that a duplicate also
   double-registers the fetch provider (`dsh-free-search-chain/cordis.patch.yml:19-20`);
   memory-evolve says "duplicate ids crash the loader"
   (`dsh-memory-evolve/cordis.patch.yml:6-7`). Conversely **multiple rows of one package are
   fine when the `id`s differ** (§6.3). Prompt-section names are a second uniqueness domain:
   "Unique name — a duplicate registration throws"
   (`$HOST/packages/core/system-prompt/src/index.ts:54`), and a real plugin guards against it
   (`dsh-memory-evolve/lib/index.js:1694-1705`, its issue #23: DSH 0.1.x could assemble a plugin
   twice on a scope-less ctx).
4. **Patch semantics are whole-row config replacement.** "A patch replaces the targeted row's
   whole `config`, so each row below restates every key it owns"
   (`$HOST/packages/bundle/web-app/cordis.patch.yml:5-6`); the profile repeats it
   (`$PROF/cordis.patch.yml:265` "fetchProvider: http MUST be restated (patch = whole-row
   replace)"), and free-search ships a *runtime* compensation because a profile `web` row
   silently erased its `searchProvider`: `if (!ctx.web.searchProviderId) ctx.web.searchProviderId
   = provider.id` with a warning log (`dsh-free-search-chain/lib/index.js:1903-1910`).
   Practical rule for a new plugin: **never depend on a config key surviving someone else's
   row-level patch**; keep defaults in the plugin and re-state everything you own.
5. **`enabled`/`disabled` are two different layers.** Row-level `disabled: true` removes the
   mount (mnemon's opt-in strategies, `dsh-mnemon/cordis.patch.yml:82-90`; profile
   `disabled: false` to re-enable `tool-web`, `$PROF/cordis.patch.yml:281-285`); config-level
   `enabled: false` is a plugin's own kill switch inside `apply`
   (`dsh-session-readcache/lib/index.js:31-34`, documented at `README.md:41`) — and a
   **row-level `disabled` also suppresses the client bundle**, because the client table only
   keeps entries that are live: `entry.options.name === entryName && entry.fiber !== undefined &&
   !entry.disabled` (`$HOST/packages/client/modules/src/index.ts:482-490`).
6. **Exporting a truthy-but-invalid `Config` kills boot.** The loader calls
   `runtime.Config['~standard'].validate(config)` whenever `runtime.Config` is truthy
   (`$HOST/vendor/cordis/src/fiber.ts:50-62`); readcache therefore exports **no** `Config` and
   normalizes with its own guards — an empty `{}` exploded in their smoke boot
   (`dsh-session-readcache.local-link.md:49-53`).
7. **`provide()` cannot override an already-registered service** ("has been registered"), and
   `ctx.reflect.set` is fiber-owner-only → to change host behavior, wrap the *instance* you
   `ctx.inject` and undo it in `ctx.effect`
   (`dsh-session-readcache.local-link.md:45-48`; the wrapping code is
   `dsh-session-readcache/lib/index.js:40-140`).
8. **A plugin that injects a service the host doesn't provide fails the whole boot** with
   `web boot: N entries did not activate` (`dsh-ui-skin-switcher.local-link.md:199-202`;
   the assertion is `$HOST/packages/boot/app-boot/src/index.ts:722-724`). The same failure also
   hides the plugin's client bundle (§9 item 5) — check `inject` lists first when a plugin "loads but
   does nothing".
9. **`link:` really means a relative symlink in the profile.**
   `$PROF/node_modules/dsh-session-readcache -> ../../../../dsh-custom/plugins/dsh-session-readcache`
   (verified with `ls -la`), and a **stale link target breaks the whole profile boot** — the
   profile once pointed `dsh-free-search` at a deleted directory and "boot profil web baru gagal
   resolve bundle" (`dsh-session-readcache.local-link.md:78-81`); the resolution error text is
   `$HOST/packages/boot/app-boot/src/profile.ts:351-354`.
10. **Restart is mandatory; `--dump-config` is the no-restart check.** Activation needs a
    `dsh web` restart ("a running server keeps its already-resolved modules",
    `dsh-session-readcache/README.md:33`; "Restart dsh web", `dsh-memory-evolve/README.md:19`;
    "restart + browser refresh", `:304`). Composition can be checked without restarting via
    `dsh --profile web --dump-config | grep -A5 <name>`
    (`dsh-session-readcache.local-link.md:68-74`), backed by `composeEntries` using the same
    patch application as boot (`$HOST/packages/boot/app-boot/src/profile.ts:405-420`).
    `[disputed]` the same doc claims rc.2 `dsh plugin add` did **not** rewrite
    `dsh.profile.bundles` (`:63-65`), while the rc.2 source reconciles automatically
    (`$HOST/apps/cli/src/plugin.ts:59-91`) — treat "verify `bundles` after add" as the safe habit.
11. **HMR is poll-based and only helps if a watcher rebuilds the bundle.** The node half
    stat-polls each graph row's `lib/client.js` (default `pollIntervalMs: 500`; polling chosen
    because network mounts deliver no inotify events) and pushes `{type:'rebuilt', id, rev}` over
    SSE `/plugins/events` (`$HOST/packages/client/hmr/src/index.ts:1-9,27-39`;
    `src/events.ts:10-16`). Its own doc states the precondition: "The web bundle mounts this row
    unconditionally: **without a rebuild watcher rewriting client bundles, the poll observes no
    changes and the chain stays idle**" (`:8-9`). The rev is a 12-hex sha1 of the file content
    carried in the URL `…/plugins/<id>/client.js?rev=<sha>`
    (`$HOST/packages/client/modules/src/index.ts:161-171,374-382`), so a rebuilt file is picked up
    per-plugin with cache-busting; **host/shell changes still need a page reload**
    (`$HOST/packages/client/hmr/src/client/index.ts:5-10`). Practical: `bundle`/`watch` scripts
    (`tsdown --watch`, `$PLUG/dsh-ui-skin-switcher/package.json:74-77`) are what make client-side
    iteration live; nothing reloads host-side `lib/index.js` in place.
12. **pnpm in a sandbox can fail with `ERR_SQLITE_ERROR`.** Every install record hits it and
    requires full access because pnpm must touch the store + the profile manifest
    (`dsh-ihaveadhd-plugin.local-link.md:61`, `dsh-superpowers-plugin.local-link.md:46`,
    `dsh-uipromax-plugin.local-link.md:58`, `dsh-ui-skin-switcher.local-link.md:217`,
    `dsh-memory-evolve.local-link.md:79`). The profile's mitigation is a workspace-local store:
    `storeDir: /home/administrator/agent-workspace/.pnpm-store`,
    `cacheDir: …/.pnpm-cache`, `confirmModulesPurge: false`
    (`$PROF/pnpm-workspace.yaml:7-12`, comment: the default store sits on a read-only root fs).
13. **A malformed `settings.yaml` bricks the next boot, not the current one.** Bad indentation
    produced `BAD_INDENT at line 5`; the running GUI was unaffected because it booted before the
    corruption, "**restart berikutnya akan gagal sampai diperbaiki**"
    (`dsh-session-readcache.local-link.md:82-89`). Same class as gotcha 9.
14. **SDK/host version drift is real.** mnemon's `devDependencies` pin the whole
    `@deepseek-ai/dsh-*` family at `0.1.2-rc.1` (`dsh-mnemon/package.json:172-198`) against an
    installed `dsh 0.1.1-rc.2` (verified: `dsh --version` → `0.1.1-rc.2`; the host checkout's
    root `package.json` `"version": "0.1.1-rc.2"`), and its `peerDependencies` accept a range of
    three host lines (`:163-164`). free-search's dual-API settings install
    (`dsh-free-search-chain/lib/index.js:1853-1885`) exists for exactly this reason. Mnemon keeps
    scripts to flip the host SDK between registry and a local checkout
    (`dsh:link-source` / `dsh:restore-registry`, `package.json:136-137`).
15. **npm tarball ≠ git tree.** The prebuilt `lib/` in the upstream repo hashed differently from
    the npm tarball's on all three files, so the fork was built from the installed npm copy
    (`dsh-ui-skin-switcher.local-link.md:55-61`); and `exports["./src/*"]` can point at a `src/`
    that the tarball does not ship (`:234-235`). For a local plugin you control both, but copy
    provenance matters when forking.
16. **Two ways a client bundle silently disappears:** no `exports["./client"]`
    → hard throw `declares dsh.client but exports no "./client" bundle`
    (`$HOST/packages/client/modules/src/index.ts:451-453`); `platform` not exactly `"web"`
    → treated as not-a-client-row, no error at all (`:447-450`).
17. **Client externals are a frozen table, not a lockfile.** The only shared modules are the keys
    in `$HOST/packages/client/web/src/seed.ts:26-34` (+ `@deepseek-ai/dsh-client-runtime/client`
    preloaded, `src/platform.ts:15-17`); the client bundle must not contain its own copies — the
    build presets enforce "client bundle purity" (`$HOST/packages/client/tsdown.client.ts:493`).
    A plugin that requires something absent (e.g. another plugin's package row) boots as
    "loaded without registering" (`dsh-memory-evolve/scripts/build.mjs:26-35` documents the id
    half of the same class of failure).
18. **`dsh-custom/cordis.yml` is a 0-byte red herring** (`ls -l` shows size 0): the profile's own
    `cordis.yml` at `$PROF/cordis.yml:4` is the composed root list and is intentionally `[]`;
    layers come from `dsh.profile.bundles`
    (`dsh-ui-skin-switcher.local-link.md:37-38`).
19. **A `link:` plugin's own dependencies are NOT hoisted into the profile root.** On this machine
    `@deepseek-ai/dsh-settings` is absent from `$PROF/node_modules/@deepseek-ai` (11 entries) yet
    free-search imports it (`lib/index.js:1`) — it resolves through the plugin's own
    `node_modules/@deepseek-ai/dsh-settings` symlink into the harness checkout (`ls -la` of
    `$PLUG/dsh-free-search-chain/node_modules`). Practical rule: run `pnpm install` **inside** the
    plugin directory before `dsh plugin add link:…`, or import nothing but `node:*` (readcache,
    zero deps, `package.json` has no `dependencies` at all).
20. **Settings namespaces are a third uniqueness domain**: `settings.register(ns, …)` throws
    `settings namespace "…" is already registered`
    (`$HOST/packages/settings/settings/src/index.ts:437`), so two plugins (or two rows of one
    plugin) must not claim the same ns — unlike loader ids (§9.3) this fails inside `apply`, and
    the whole profile boot then fails with `entries did not activate` (`app-boot/src/index.ts:722-724`).

## 10. Recommended scaffold for a new plugin (host tools + routes + turn context + client settings panel + session tab)

Design decisions, each traced to an observed winner:

| decision | why (source) |
| --- | --- |
| **One package, two faces** (`lib/index.js` + `lib/client.js`), not a monorepo | free-search ships exactly this shape with tools + routes + a settings panel (`dsh-free-search-chain/package.json:7-16`); mnemon's 16-package split exists only to make memory Sources/Providers swappable (`dsh-mnemon/cordis.patch.yml:50-90`) and would add the `pnpm -r build` tax (§9.2) |
| **`dsh.bundle.patch` is mandatory**, and the plugin inserts its own single row | CLI only treats a package as a layer when `dsh.bundle.patch` exists (`$HOST/apps/cli/src/plugin.ts:36-45,66-69`) and boot throws without it (`profile.ts:391-394`); self-mounting rows are what every studied plugin does (§1.4, skin `cordis.patch.yml:7-9`, memory-evolve `:8-10`) |
| **Row `id` = short feature name, row `name` = package name**; never add a second row for it in the profile patch | client bundle id is derived from the entry `name` (`dsh-memory-evolve/scripts/build.mjs:26-37`, `$HOST/packages/client/modules/src/index.ts:484`); duplicate ids are the loudest documented failure (§9.3) |
| **Host entry exports `name / inject / provide / Config / apply`** | the cordis contract (`$HOST/vendor/cordis/src/registry.ts:100-133`) and every studied host face: readcache `lib/index.js:7-9,142`, mnemon `src/index.ts:1`, tool-fs `src/index.ts:19-40` |
| **Declare `Config` with schemastery `.default()` + `.role("secret")`; never export a truthy non-schema `Config`** | free-search `lib/index.js:1596-1615`; validator is `Config['~standard'].validate` (`$HOST/vendor/cordis/src/fiber.ts:50-62`, §9.6) |
| **Own settings namespace, registered via the host helper, so the Settings UI renders it for free** | `installSettingsSection(ctx, ns, schema, entry, hooks)` (`$HOST/packages/settings/settings/src/index.ts:863-897`); runtime proof: `free-search:` / `mnemon:` / `ui-theme:` blocks in `$DSH_HOME/settings.yaml:142,115,144` |
| **HTTP routes via `ctx.webServer.register({kind,path,handler})` + own guard** | route type (`$HOST/packages/host/webserver/src/index.ts:38-48`); prefix route (`dsh-memory-evolve/lib/api.js:846`); loopback+method guard (`dsh-free-search-chain/lib/index.js:1221-1233,1480-1487`) |
| **Turn context = `systemPrompt.context()` (per-assembly, sees `context.agent`), plus `agent/pre-step` only if you must append durable messages** | memory-evolve `lib/index.js:1681-1707`; host types `$HOST/packages/core/system-prompt/src/index.ts:53-84` + `packages/core/agent/src/runtime-types.ts:16-21`; message-append precedent `$HOST/packages/context/time-context/src/index.ts:170-208` |
| **Client surfaces: `settings.section` for the panel page, `conversation.view` for the session tab, `ctx.settingsScope.bind()` for read/write** | mnemon does both with exactly these (`lib/client.js:8263-8289`, `:8199-8217`); the in-box minimal form of the scope bind is `ui-theme/src/client/index.ts:377,385-415`; `platform` must be `"web"` and `exports["./client"]` must exist (§9.16) |
| **Ship `lib/` built from `src/` with one `tsdown` config; gitignore `lib/` only if the README says to build first** | mnemon's two-face config (`tsdown.config.ts:19-61`), the client artifact trio (`banner/intro/footer`, `:56-60`), and §9.1-2 explaining why "clone without build" breaks |
| **Data in a per-workspace dot-dir + a home-dir fallback, never inside the plugin dir** | mnemon `storageScope=workspace → <workspace>/.mnemon` with `.mnemon/` gitignored (`docs/en/reference/storage-model.md:60`, `.gitignore:10`); readcache proves zero-persistence is also fine (§2.5) |

### 10.1 File list (create exactly these)

```
dsh-cortex/
  package.json                      layer manifest: name/version/main/exports/files + dsh.bundle|client|engines
  cordis.patch.yml                  the ONE self-insert row (id: cortex) with every default restated
  tsdown.config.ts                  two faces: host ESM (node) + client CJS w/ __ModuleLoader__ banner
  tsconfig.json                     src/*.ts typecheck root (noEmit; dts via tsc -p tsconfig.types.json if needed)
  .gitignore                        node_modules/ + /lib/ + /.cortex/  (see §9.1: build before link)
  README.md                         user-facing: what/why/install/config table/rollback (§2.7 style)
  dsh-cortex.local-link.md          the §8 convention doc (Layout/Patch/Install/Static/ Runtime/Limits/Revert)
  src/index.ts                      host face barrel: export { name, inject, provide, Config, apply }
  src/host/plugin.ts                apply(): wires settings, tools, routes, prompt context (the orchestrator)
  src/host/config.ts                `Config = z.object({...defaults, secret fields .role("secret")})`
  src/host/settings.ts              settings namespace + installSettingsSection bridge (host)
  src/host/tools.ts                 defineTool(...) payloads + ctx.tools.register() in ctx.effect
  src/host/routes.ts                { kind:'prefix', path:'/cortex', handler } + loopback/method guard
  src/host/context.ts               systemPrompt.context({name:'cortex:snapshot', order, text}) + idempotency catch
  src/host/store.ts                 JSON/append persistence under <cwd>/.cortex or $DSH_HOME/cortex
  src/client/index.ts               client face barrel: export const inject / function apply
  src/client/panel.tsx              settings.section component (reads ctx.settingsScope)
  src/client/tab.tsx                conversation.view component (session tab body)
  src/client/styles.module.css      CSS Modules (compiled+inlined by the client build, §4.9)
  src/client/locales.ts             { zh, en } dictionaries registered under one locale namespace
  src/invariant.ts                  OPTIONAL in-box companion; skip unless you copy that convention
  tests/*.test.mjs                  node --test against fakes (readcache tests/ pattern, §2.1)
  scripts/smoke.mjs                 OPTIONAL: isolated boot probe that greps for the mount log line
```

### 10.2 `package.json` (fields only; values are the verified shapes)

```json
{
  "name": "dsh-cortex",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib/index.js", "lib/client.js", "cordis.patch.yml", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": { "build": "tsdown", "watch": "tsdown --watch", "test": "node --test 'tests/*.test.mjs'", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@deepseek-ai/dsh-settings": "0.1.1-rc.2", "@deepseek-ai/schemastery": "^3.18.1" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.1.0-rc.6", "@deepseek-ai/cordis": "^4.0.1", "react": "^18.2.0" },
  "dsh": {
    "bundle": { "patch": "cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-locale"] },
    "engines": { "dsh": ">=0.1.1-rc.1" }
  }
}
```

Shape sources, field by field: `main`/`exports`/`files` = free-search `package.json:6-16`;
`dsh.bundle.patch` = readcache `:28-30`; `dsh.client.{inject,platform}` = free-search `:56-61` +
skin-switcher `:36-43` + mnemon root `:106-115` (all four list the client packages they consume);
`dsh.engines.dsh` = readcache `:31-33` `[verified as present]` but note it is **not** in the host's
`DshManifestSection` type (`$HOST/packages/boot/app-boot/src/profile.ts:57-62`) →
`[unverified-claim]` that anything consumes it; tools-as-peer = free-search `:46-51`.
`@deepseek-ai/dsh-settings` as a real dependency is what free-search does
(`package.json:43`) and what makes its runtime import work through the plugin's own
`node_modules` symlink (`dsh-free-search-chain/node_modules/@deepseek-ai/dsh-settings ->
…/deepseek-harness/packages/settings/settings`, seen with `ls -la`) — a `link:` plugin's deps must
resolve **from the plugin directory**, not from the profile (the profile root has no
`@deepseek-ai/dsh-settings`; verified by `ls`).

### 10.3 `cordis.patch.yml`

```yaml
# dsh-cortex bundle patch: the ONE row this package needs. Installed via
# `dsh plugin --profile web add link:/abs/path/dsh-cortex`, which also appends
# "dsh-cortex" to dsh.profile.bundles. Do NOT insert this row again in the
# profile's cordis.patch.yml (duplicate loader id). Config is restated in full
# because a profile-level patch replaces the whole config of a matched row.
- insert:
    - id: cortex
      name: dsh-cortex
      config:
        enabled: true
        snapshotOrder: 160
        maxEntries: 200
```

Comment wording + restating rule are lifted from
`$HOST/packages/bundle/web-app/cordis.patch.yml:5-6` and
`$PROF/cordis.patch.yml:259-265`; the `enabled: true` kill-switch habit is
`dsh-session-readcache/cordis.patch.yml:5` + `lib/index.js:31-34`.

### 10.4 `src/index.ts` + `src/host/plugin.ts` (host face)

```ts
// src/index.ts
export { name, inject, provide, Config, apply } from './host/plugin.ts'

// src/host/plugin.ts  — every line below is a copy of a working registration
export const name = 'cortex'                                   // pattern: readcache lib/index.js:7
export const inject = ['tools', 'settings', 'systemPrompt', 'webServer']   // pattern: tool-fs src/index.ts:22; memory-evolve lib/index.js:73
export const provide = []                                      // add 'cortexStore' only if others consume it
export function apply(ctx: Context, config: CortexConfig = {}): void {
  if (config.enabled === false) { ctx.logger?.info?.('[cortex] disabled by config'); return }  // readcache lib/index.js:31-34
  installCortexSettings(ctx, config)                           // §10.5
  registerCortexTools(ctx, config)                             // §10.6
  registerCortexRoutes(ctx, config)                            // §10.7
  registerCortexTurnContext(ctx, config)                       // §10.8
}
```

If a service you inject may not exist in another profile (headless), do **not** put it in
`inject`; fetch it lazily: `const current = () => ctx.get("workspaceRegistry")` with `?.`
fallbacks — `dsh-mnemon/lib/index.js:8707-8714`.

### 10.5 settings namespace (so the plugin is "ready on install")

```ts
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
const NS = settingsNamespace('cortex')                         // helper exists on rc.2: $HOST/packages/settings/settings/src/index.ts:26
installSettingsSection(ctx, NS, Config, config, {
  setSource: (source) => { current = source },                 // hooks: …/src/index.ts:829-848
  onChange: () => { refreshSnapshot() },
})
```

`installSettingsSection` registers `ns` with the composition entry as `base` layer and falls back
to it when the settings service detaches (`$HOST/packages/settings/settings/src/index.ts:863-897`).
Two hard rules from the same file: the namespace must be unique — `settings.register` throws
`settings namespace "…" is already registered` (throw text at `:437`, `register<T>(ns, schema, options)` body) — and user config then lives at
`$DSH_HOME/settings.yaml` under `cortex:` (compare `free-search:` at `:142`). On newer hosts
prefer the method form when present, exactly as free-search feature-detects
(`dsh-free-search-chain/lib/index.js:1853-1885`).

### 10.6 host tools

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'            // free-search lib/index.js:2
function registerCortexTools(ctx: Context, config: CortexConfig): void {
  ctx.effect(() => ctx.tools.register(defineTool({              // both wrappers seen live: memory-evolve lib/index.js:1710, free-search lib/index.js:1992-1995
    name: 'cortex_recall',                                      // → model sees exactly this name
    description: '…when to use this, and when NOT to…',
    parameters: { query: { type: 'string', required: true, description: '…' },        // shorthand form: $HOST/packages/fs/tool-fs/src/read.ts:79-83
                  limit: { type: 'number', description: '…' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { … } },
              render(_args, value) { return '…' } },            // full form incl. presentationMeta: mnemon lib/index.js:6760-6764
    async execute(args, exec) { … return { … } },                // exec.signal: memory-evolve / mnemon lib/index.js:6765-6769
  }), 'cortex: recall tool')                                    // ctx.effect(label) = auto-dispose on unmount/HMR
}
```

Use the JSON-Schema-object form (`parameters: { type:'object', properties, required:[…] }`) if
you want `presentCall`/`presentResult` cards — that is what mnemon passes
(`lib/index.js:6745-6779`).

### 10.7 HTTP routes

```ts
function registerCortexRoutes(ctx: Context, store: Store): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',                       // 'exact' per path, or one prefix dispatcher: memory-evolve lib/api.js:846
    path: '/cortex',                      // absolute, no trailing slash: $HOST/packages/host/webserver/src/index.ts:44-45
    handler: async (req, res) => {        // owns the whole response (may stay open for SSE): :46-47
      if (!allow(req, res)) return        // loopback + method guard, see below
      …writeJson(res, 200, value)
    },
  }), 'cortex: api routes')
}
// guard, verbatim logic from dsh-free-search-chain/lib/index.js:1221-1233,1480-1487
function isLoopbackRequest(req) {
  const a = req.socket.remoteAddress
  if (a !== '127.0.0.1' && a !== '::1' && a !== '::ffff:127.0.0.1') return false
  const host = req.headers.host; if (typeof host !== 'string') return false
  const h = new URL('http://' + host).hostname
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}
```

Keep a **whitelist** for anything that writes secrets, and go through the credentials service
rather than the settings file when you can: `KEY_REF_MAP` + `credentials.set(ref, value)`
(`dsh-free-search-chain/lib/index.js:1585-1594,1448-1463`).

### 10.8 turn-context injection

```ts
function registerCortexTurnContext(ctx: Context, config: CortexConfig): void {
  if (!config.injectSnapshot) return
  ctx.effect(() => {
    try {
      return ctx.systemPrompt.context({                        // shape: $HOST/packages/core/system-prompt/src/index.ts:78-84
        name: 'cortex:snapshot',                               // unique or it throws (:54)
        order: config.snapshotOrder ?? 160,                    // tool guidance band is 100-199 (:56-61)
        text: (context) => renderSnapshot(store, context.agent),   // context.agent is real: packages/core/agent/src/runtime-types.ts:16-21
      })
    } catch (error) {                                          // idempotency catch: dsh-memory-evolve/lib/index.js:1694-1705
      if (error instanceof Error && error.message.includes('already registered')) {
        console.warn('[cortex] snapshot already registered, skipping duplicate')
        return () => {}
      }
      throw error
    }
  }, 'cortex: turn snapshot')
}
```

If the injection must be **durable model-visible history** instead of a prompt fragment
(the MNEMON-snapshot behaviour), add the pre-step listener instead:

```ts
ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
  const decision = await next()
  if (decision.kind === 'reject' || signal.aborted) return decision
  return { kind: 'enter', messages: [...decision.messages, createUserMessage({
    content: [{ type: 'text', text: snapshotFor(agent, turn) }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
  })] }
}, { prepend: true })                                          // $HOST/packages/context/time-context/src/index.ts:170-208
```

Static guidance (not per-turn state) belongs in `ctx.systemPrompt.section({ name: 'tool:cortex',
order: 100, text: '…' })` (`$HOST/packages/fs/tool-fs/src/read.ts:70-74`).

### 10.9 client face (`src/client/index.ts`)

```ts
export const inject = ['slots', 'locale', 'connection', 'settingsScope']   // $HOST/packages/client/ui-theme/src/client/index.ts:377
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<CortexSettings>({ namespace: 'cortex' })   // :387
  ctx.effect(() => ctx.locale.register('cortex.panel', { zh, en }), 'cortex: dictionaries')  // :391
  ctx.effect(() => injectCss(CSS))                             // dsh-ui-skin-switcher/src/client/index.ts:120 (injectCss :18-26)

  ctx.slots.inject('settings.section', () => ctx.slots.register({   // own Settings page: dsh-mnemon/lib/client.js:8263-8268
    name: 'settings.section', id: 'cortex', order: 30,
    label: () => ctx.locale.bind('cortex.panel')('tab.label'), locale: 'cortex.panel',
    inject: () => ({ scope, connection: ctx.connection, t: ctx.locale.bind('cortex.panel') }),
  }, CortexPanel))                                             // panel component: src/client/panel.tsx

  const disposeTab = ctx.slots.inject('conversation.view', () => ctx.slots.register({  // session tab: dsh-mnemon/lib/client.js:8199-8217
    name: 'conversation.view', id: 'cortex', order: 40,
    label: () => ctx.locale.bind('cortex.panel')('tab.label'), locale: 'cortex.panel',
    inject: (sessionId) => ({ connection: ctx.connection, sessionId, scope, t: ctx.locale.bind('cortex.panel') }),
  }, CortexTab))
  ctx.effect(() => () => disposeTab(), 'cortex: session tab')   // disposers returned into ctx.effect: skin-switcher :120, mnemon :8218-8229
}
```

RPC to your own routes from the panel is plain `fetch('/cortex/…')` (same origin, so the
loopback guard passes); RPC to host session data is
`ctx.connection.api.sessions.<method>({ sessionId })` → `{ ok, value | error }`
(`dsh-ui-skin-switcher/src/client/index.ts:112-115,145-152`). A settings card is also available
without owning a page: `settings.plugin.item` keyed slot
(`dsh-free-search-chain/lib/client.js:967-977`) — start with `settings.section`, it is what mnemon
and `ui-theme` do for real pages.

### 10.10 build config + verification checklist

Copy `$PLUG/dsh-mnemon/tsdown.config.ts` structure: host config (`format:['esm']`,
`platform:'node'`, `target:'es2024'`, `outDir:'lib'`, `clean:true`, `deps:{neverBundle:true}`,
`:19-34`) and client config (`format:'cjs'`, `platform:'browser'`, `target:'es2022'`,
`external` = the frozen platform table (`$HOST/packages/client/web/src/seed.ts:26-34`),
`outputOptions.banner/intro/footer` = the `__ModuleLoader__.load` trio (`:56-60`), CSS plugin
inlining a `<style data-plugin-css>` tag (`:89-95`)). Then:

1. `pnpm build` → `lib/index.js` + `lib/client.js` exist (§9.1-2: nothing works without this).
2. `node --check lib/index.js && node --check lib/client.js` (the static gate in every
   `.local-link.md`, e.g. `dsh-ui-skin-switcher.local-link.md:213`).
3. `grep -c 'window.__ModuleLoader__.load({ id: "dsh-cortex"' lib/client.js` → 1, and that id
   **equals** `package.json` `name` (§9.17, `scripts/build.mjs:26-37`).
4. `dsh plugin --profile web add link:/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex`
   → then check BOTH `$PROF/package.json` `dependencies["dsh-cortex"]` and
   `dsh.profile.bundles` contains `"dsh-cortex"` (§1.3, and §9.10 `[disputed]` reconciliation).
5. No-restart composition check: `dsh --profile web --dump-config | grep -A5 dsh-cortex`
   (`dsh-session-readcache.local-link.md:68-74`).
6. Restart `dsh web` (nothing hot-loads host-side `lib/index.js`, §9.10-11) and confirm the mount
   log line; on failure grep the server log for `entries did not activate` (§9.8).
7. Settings proof: `cortex:` block appears in `$DSH_HOME/settings.yaml` after a save
   (compare `:142`); client proof: DevTools shows `/plugins/dsh-cortex/client.js?rev=…`
   (`$HOST/packages/client/modules/src/index.ts:166-171`).
8. Write `dsh-cortex.local-link.md` per §8 before handing it over.
