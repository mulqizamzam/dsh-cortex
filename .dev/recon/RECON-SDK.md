# RECON-SDK — DSH plugin-SDK API map

Host: `/home/administrator/deepseek-harness` @ 0.1.1-rc.2 (pnpm monorepo)
Profile: `/home/administrator/agent-workspace/.dsh/profiles/web`
Reference 3rd-party bundle: `/home/administrator/agent-workspace/dsh-custom/plugins/dsh-memory-evolve`
Status: COMPLETE (all 8 sections). All claims cite `path:line`. Paths are relative to the host checkout unless absolute.

## 0. TL;DR / quick answers

1. **Anatomy.** Plugin = a module exporting `apply(ctx, config)` (+ optional `name`, `inject`,
   `Config`). Shipped as a **bundle**: `package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,
   whose YAML is an array of `EntryOptions` rows (`id`, `name`, `config`, `group`, `disabled`, `inject`).
   `inject: string[]` gates boot by **service name**: a wrong name = PENDING forever, and the boot
   audit turns it into `dsh: N entries did not activate … pending (waiting for service: x)`
   (`packages/boot/app-boot/src/index.ts:716-719`). Duplicate **`id`** in one composed row list →
   `TypeError: duplicate loader entry id: <id>` (`vendor/loader/src/config/group.ts:64`).
   Only three `dsh.*` manifest keys exist: `dsh.bundle.patch`, `dsh.profile.bundles`, `dsh.client`.
   **`dsh.engines.dsh` is read by nobody** — decoration.
2. **Host ctx.** ~75 real injectable service names enumerated in §2.2 with `file:line`.
   Tools: `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`
   (`packages/core/tools/src/index.ts:1037`). JSON Schema is a **closed subset**; anything outside
   rejects via `assertSupportedJsonSchema` (`packages/core/tools/src/json-schema.ts:385`).
   Text into the model each turn = `ctx.systemPrompt.section()` / **`.context()`** (user-role
   durable snapshot, cache-friendly), or `agent.inject(message)` for the next pre-step, or the
   `agent/pre-step` / `system-prompt/assemble` waterfalls. **No** "conversation middleware", **no**
   `before-turn` event.
3. **Client ctx.** Register React components into typed **slots**
   (`ctx.slots.register({ name, id|key, inject }, Component)`); the full slot inventory is §3.3
   (40 keys). Locales via `ctx.locale.register(ns, {zh, en})` + a `LocaleNamespaceMap` merge.
   Host RPC from the browser: (A) `@Remote` on a `TypertRemoteService` → `POST /api/<ns>/<method>`;
   (B) `ctx.connection.rpc.call('/api', …)`; (C) your own `fetch()` to your own `webServer` route.
   `RpcMethodMap` is **closed** — you cannot add a method. Sessions methods listed in §3.5.
4. **webServer.** `ctx.inject(['webServer'], c => c.effect(() => c.webServer.register({kind,path,handler})))`.
   Duplicate `(kind, path)` throws; `registerFallback` has exactly **one** owner. **The webserver has
   zero auth/TLS/CORS/origin logic** (`docs/subsystems/web-server.md:41`; 0-hit greps §4.3); the
   `/api` browser-trust fence lives in a different package and covers only `/api`. Your route is
   anonymous — guard it yourself (worked template in §4.4).
5. **Persistence.** No sanctioned per-plugin data dir exists. Convention: `$DSH_HOME/<your-name>/`,
   path derived from a `dshHome?: string` config field via `resolveDshHome` /
   `ctx.dshHomePath(...)` (`packages/util/home-paths/src/index.ts:87,98`). Structured KV =
   `ctx.storageDomain` (composition-dependent; only the web bundle mounts it). Config = patch row
   `config:` (**whole-value replace, never deep-merge**) + a Schemastery `Config` schema carrying
   defaults + optionally a `settings` namespace via `installSettingsSection`.
6. **Lifecycle.** `dsh plugin` = `pnpm` forwarder + `dsh.profile.bundles` reconciler. **Uninstall
   deletes no plugin data and there is no cleanup/uninstall hook** (§6.2, greps shown). Restart the
   profile after add/remove/update.
7. **Subprocess / LLM.** `ctx.subprocess` (`spawn`/`spawnTerminal`/`resolveExecutable`,
   `packages/subprocess/subprocess/src/index.ts:103-140`), `ctx.jobs.start(...)` for long work,
   `ctx.llm.stream(GenerateOptions)` for direct model calls (§7.3 has a verbatim example).
   **No `ctx.schedule`** and **no host-side `ctx.timer`** — both verified absent.
8. **Build.** In-box uses `tsc -b` → `lib/types`, then one root `tsdown` workspace pass → `lib/`.
   A standalone local plugin only needs the **artifact shape**: `lib/index.js` (ESM), and for a
   browser half `lib/client.js` as CJS wrapped in
   `window.__ModuleLoader__.load({ id: <package name>, factory: (require) => { … } })`.
   `lib/` is gitignored (root `.gitignore:5`; `dsh-mnemon/.gitignore:3`), `exports` point at
   `lib/*.js`, and `pnpm -r build` only reaches **workspace members that define a `build` script** —
   so it never builds a `link:`-installed plugin from the profile dir. Full gotcha chain §8.4.

### Section confidence
| § | confidence |
|---|---|
| 1 anatomy | verified-by-code |
| 2 host API | verified-by-code (service list = exhaustive grep; §2.4 four seams verified) |
| 3 client API | verified-by-code; `dsh.client`'s optional keys (`immediately`, `external`) are doc+grep, not runtime-exercised |
| 4 webServer | verified-by-code; auth absence = verified by 0-hit greps + the owning doc's own sentence |
| 5 persistence | verified-by-code for what exists; "no sanctioned per-plugin dir" = **not-found**, greps shown |
| 6 lifecycle | verified-by-code; "no cleanup hook" = **not-found**, greps shown; §6.4's `dsh plugin add` wart is a field observation that contradicts nothing in code |
| 7 subprocess/LLM | verified-by-code; `ctx.timer` / `ctx.schedule` absence = **not-found**, greps shown |
| 8 build toolchain | §8.1–8.3, §8.5 verified-by-code; §8.4 items 2–3 **inferred** from workspace files; item 4 documented, not executed |

### 0.1 Naming correction that changes the whole survey

`packages/sdk/` is **not** the plugin-authoring SDK. It is the out-of-process client
(`@deepseek-ai/dsh-sdk-client`, `packages/sdk/client/package.json:2`) that drives a DSH
runtime subprocess over stdio JSON-RPC (`packages/sdk/README.md:1-10`).

The plugin-authoring surface is:
- `@deepseek-ai/cordis` (vendored at `vendor/cordis/`) — the DI/plugin framework: `Context`, `Service`, `Plugin`, `inject`, `apply`, fibers, events.
- `@deepseek-ai/cordis-plugin-loader` (`vendor/loader/`) — YAML-driven plugin entry registration (`EntryOptions`).
- The `@deepseek-ai/dsh-*` packages under `packages/*/*` — each one *is* a plugin and provides one service on `ctx`.
- `apps/cli/src/plugin.ts` + `packages/boot/app-boot/src/profile.ts` — the install/profile layer.
- `packages/client/tsdown.client.ts` — the client (browser) bundle build.

---

## 1. Plugin package anatomy

### 1.1 A plugin is a module with `apply` (+ optional `name`, `inject`)

`docs/user/develop/basic/index.md:19-31` — the canonical minimal plugin:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // Register capabilities here.
}
```

Three accepted shapes, `vendor/cordis/src/registry.ts:92-133`:
- `Plugin.Function<T>` = `(ctx: Context, config: T) => any` — `registry.ts:121-123`
- `Plugin.Constructor<T>` = `new (ctx, config)` class — `registry.ts:126-128`
- `Plugin.Object<T>` = `{ apply(ctx, config) }` — `registry.ts:131-133`

Metadata fields the registry reads (`Plugin.Base`, `vendor/cordis/src/registry.ts:100-111`):
`name?`, `Config?` (a Standard Schema validator), `inject?`, `provide?`, `intercept?`.
Shape resolution: `RegistryService.resolve()` accepts a function, or an object whose
`.apply` is a function — `registry.ts:222-228`; anything else throws
`invalid plugin, expect function or object with an "apply" method` — `registry.ts:319`.

Object form and class form examples: `docs/user/develop/basic/index.md:96-127`.

### 1.2 How `export const inject` gates boot

`inject` is a **service-name list** (or a name→intercept-config map): `vendor/cordis/src/registry.ts:19`
```ts
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
```
Normalized by `Inject.resolve()` — `registry.ts:71-88`.

Semantics (`vendor/cordis/src/registry.ts:105-106`, `docs/user/develop/framework/index.md:19-27`):
> `inject?: Inject` — "Services the plugin requires; it only loads while all are available."

Fiber state machine — `docs/user/develop/framework/index.md:5-17`:
`PENDING → LOADING → ACTIVE` (`↘ FAILED`), `ACTIVE → UNLOADING → DISPOSED`.
PENDING = "Declared, but required dependencies are not ready". So a wrong/unprovided
name in `inject` means **the plugin silently never loads** (it stays PENDING), and if a
required service disappears, the plugin auto-unloads and reloads when it returns
(`docs/user/develop/framework/index.md:29-37`).

Optional dependency = omit `inject`, use `ctx.get('name')` at the use site —
`docs/user/develop/framework/service.md:75-88`.

**Client-side vs host-side `inject` names differ**, because the two halves are two
different cordis contexts. Verified-by-code: a client plugin's `inject` names
*browser* services (`slots`, `conversationEvents`, `conversationViews`, `sessions`,
`locale`, `theme`, `modules`, `clientModules`, `layout`, `connection`, …) — real example
`packages/client/ui-trajectory/src/client/index.ts:23`:
```ts
export const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale']
```
A host plugin's `inject` names node services (`tools`, `llm`, `agents`, `systemPrompt`,
`webServer`, `storage`, `settings`, `sessions`, `subprocess`, `jobs`, …).
The host entry of that same client plugin is a **no-op apply** —
`packages/client/ui-trajectory/src/index.ts:3-5`:
```ts
/** Host loader entry for the browser-only trajectory plugin. */
export function apply(): void {}
```
Confidence: verified-by-code.

### 1.3 `dsh.*` package.json manifest keys — exactly three exist

Grepped: `grep -rn "manifest\.dsh" --include=*.ts packages apps` (non-test hits only).

| key | read by | meaning |
|---|---|---|
| `dsh.bundle.patch` | `packages/boot/app-boot/src/profile.ts:391` (`bundleManifest.dsh?.bundle?.patch`), `apps/cli/src/plugin.ts:44` | string path, relative to package root, to the patch YAML this bundle contributes |
| `dsh.profile.bundles` | `packages/boot/app-boot/src/profile.ts:300,387` | ordered `string[]` of bundle package names |
| `dsh.client` | `packages/typert/generator/src/analyzer.ts:2629-2636` (`isDualFacePackage`), `packages/client/tsdown.client.ts:421` | object marking the package as a browser plugin |

Types: `DshBundleManifest { patch: string }` — `packages/boot/app-boot/src/profile.ts:42-45`;
`DshProfileManifest { bundles?: string[] }` — `:48-51`;
`DshManifestSection { bundle?, profile? }` — `:57-63`;
`ProfileManifest { name?, dependencies?, peerDependencies?, dsh? }` — `:64-70`.
Doc: `docs/user/develop/basic/publish.md` "Two concepts, two manifests".

**`dsh.client` shape** — from `docs/subsystems/client-modules.md` "The scan" and
`packages/client/tsdown.client.ts:397-405`:
```json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-locale", "..."], "platform": "web" } }
```
Real example verbatim: `packages/client/ui-trajectory/package.json:32-42`. Optional keys:
`inject` (package-name edges, informational), `external` (`tsdown.client.ts:405` reads
`dsh.client.external` via `optionalStringArray`), `immediately` (stage-one prefetch).
A package joins the browser table only if it declares `dsh.client` **and** has an
`exports["./client"]` subpath — `analyzer.ts:2629-2636` + `clientExportSubpaths()` at `:2646`.

### 1.4 What makes a "bundle patch"

`dsh.bundle.patch` is the only marker. Reference (`packages/bundle/base/package.json:35-39`):
```json
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```
And the patch file is listed in `files:` (`packages/bundle/base/package.json:31-35`) plus an
explicit export `"./cordis.patch.yml": "./cordis.patch.yml"` (`:24`).
The module itself carries **no runtime API** —
`packages/bundle/base/src/index.ts:1-8` ends with `export {}` (`:8`).
A test asserts the manifest contract: `packages/bundle/base/tests/base.spec.ts:15,23,25`
(`expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')`).

The web-app bundle documents the same thing at `packages/bundle/web-app/src/index.ts:3`.

**A package without `dsh.bundle` still installs but activates nothing** —
`apps/cli/src/plugin.ts:44` (`hasBundleManifest`) is the gate; the doc states it at
`docs/user/develop/basic/publish.md` ("prints a warning and activates no layer").

### 1.5 Loader entry registration + the "duplicate loader entry id" failure

Loader entry record — `vendor/loader/src/config/entry.ts:8-23`:
```ts
export interface EntryOptions {
  id: string          // stable id inside the containing entry tree
  name: string        // module specifier imported by the entry tree
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: Inject | null
}
```
Those are exactly the YAML keys of a `cordis.yml` / `cordis.patch.yml` row.

**The failure mode**, verbatim `vendor/loader/src/config/group.ts:59-66`:
```ts
  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    const seen = new Set<string>()
    for (const options of config) {
      const id = this.tree.ensureId(options)
      if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`)
      seen.add(id)
    }
```
So: the throw fires when **two rows in the same composed list resolve to the same `id`**,
not when two bundles insert different rows with the same `name`. `id` is the key.
`ensureId` — `vendor/loader/src/config/tree.ts:66-73` — auto-assigns a random 8-char hex
id when `id` is absent, so omitting `id` avoids the collision but gives you an unstable id.
On throw, `group.ts:85-99+` rolls back newly-created entries and re-creates the old config.
Nested ids are `parent/child` joined by `EntryTree.sep` — `entry.ts:73-79`.

Confidence: verified-by-code.

## 2. Host-side plugin API

### 2.1 `ctx` — the Context object

`Context` is a **runtime Proxy** (`vendor/cordis/src/context.ts:34-41`): "A context is a
proxy: normal property reads go through the service resolver". Its declared base shape is
`vendor/cordis/src/context.ts:16-33`:

| member | line | meaning |
|---|---|---|
| `root: this` | `:22` | root context |
| `baseUrl?: string` | `:24` | base URL resolving relative plugin specifiers |
| `events: EventsService` | `:26` | bus; methods mixed onto `ctx` (`ctx.on`, `ctx.emit`, `ctx.waterfall`) |
| `logger: LoggerService` | `:28` | `ctx.logger(name)` → named logger |
| `reflect: ReflectService` | `:30` | backs `ctx.get`, `ctx.provide` |
| `registry: RegistryService` | `:32` | methods mixed onto `ctx` (`ctx.plugin`, `ctx.inject`) |

Own methods on the class: `extend(meta?)` `:99`, `isolate(name, label?)` `:121`,
`intercept(name, config)` `:141`. Plus `fiber` (set in ctor `:77`).

Mixed in from `RegistryService` (`vendor/cordis/src/registry.ts:164-187`):
```ts
inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
```
`registry.inject()` is literally `this.plugin({ inject, apply: callback, name: callback.name })`
— `registry.ts:300-302`. **This is the nested/gated-injection primitive**: the callback only
runs while all named services exist, and re-runs when they return.

### 2.2 Real injectable host service names (enumerated from code)

Method: `grep -rn "declare module '@deepseek-ai/cordis'" --include=*.ts packages | grep -v /lib/`
then read each `interface Context { … }` block. Every row below is a `ctx.<name>` property
declaration with its site.

**Agent / model / turn spine**
| name | type | site |
|---|---|---|
| `tools` | `ToolRuntime` | `packages/core/tools/src/index.ts:139` |
| `agents` | `AgentRegistry` | `packages/core/agent/src/index.ts:38` |
| `agent?` | `Agent` | `packages/core/agent/src/index.ts:48` |
| `agentLoop` | `AgentLoop` | `packages/core/agent-loop/src/index.ts:162` |
| `configuredAgentIdentities?` | `ConfiguredAgentIdentities` | `packages/core/agent-loop/src/index.ts:171` |
| `agentDefaultModel` | `AgentDefaultModelConfig` | `packages/core/agent-default-model/src/index.ts:16` |
| `agentPresets` | `AgentPresets` | `packages/preset/agent-presets/src/index.ts:71` |
| `llm` | `LlmRuntime` | `packages/llm/llm/src/index.ts:49` |
| `tokenMeter` | `TokenMeter` | `packages/llm/token-meter/src/index.ts:69` |
| `systemPrompt` | `SystemPrompt` | `packages/core/system-prompt/src/index.ts:15` |
| `compaction` | `CompactionEngine` | `packages/compaction/compaction/src/index.ts:83` |
| `toolResultPruner` | `ToolResultPruner` | `packages/compaction/compaction-tool-result-pruner/src/index.ts:34` |
| `subagents` | `SubagentRuntime` | `packages/subagent/subagent/src/index.ts:131` |
| `agentTeams` | `TeamService` | `packages/experimental/agent-team/src/index.ts:37` |
| `workflowEngine` | `WorkflowEngine` | `packages/workflow/workflow/src/index.ts:33` |
| `skills` | `SkillRegistry` | `packages/skill/skill/src/index.ts:286` |
| `planMode` | `PlanModeController` | `packages/plan/plan-mode/src/index.ts:59` |
| `goals` | `GoalService` | `packages/goal/goal/src/index.ts:61` |
| `codeRuntime` | `CodeRuntime` | `packages/code-runtime/code-runtime/src/index.ts:91` |

**Session / persistence**
| name | type | site |
|---|---|---|
| `sessions` | `SessionStore` | `packages/core/session/src/index.ts:39` |
| `sessionPersistence` | `SessionPersistence` | `packages/session/session-persistence/src/index.ts:62` |
| `sessionProjections` | `SessionProjectionRegistry` | `packages/session/session-projection/src/index.ts:26` |
| `sessionProjectionCache` | `SessionProjectionCache` | `packages/session/session-projection-cache/src/index.ts:32` |
| `sessionTitle` | `SessionTitleService` | `packages/session/session-title/src/index.ts:90` |
| `sessionTelemetry` | `SessionTelemetryBackend` | `packages/session/session-telemetry/src/index.ts:21` |
| `sessionQuery` | `SessionQueryEngine` | `packages/session-query/session-query/src/index.ts:70` |
| `launcherSessionQueryPath?` | `string` | `packages/session-query/session-query-sqlite/src/index.ts:71` |
| `sessionReferenceResolver` | `SessionReferenceResolver` | `packages/context/session-reference/src/index.ts:60` |
| `fileReferences` | `FileReferenceService` | `packages/context/file-reference/src/index.ts:22` |
| `attachments` | `AttachmentStore` | `packages/attachment/attachment/src/index.ts:32` |
| `spillStore` | `SpillStore` | `packages/spill/spill/src/index.ts:25` |
| `storage` | `Storage` | `packages/storage/storage/src/index.ts:32` |
| `storageDomain` | `DomainFacility` | `packages/storage/storage-domain/src/index.ts:37` |
| `messageFeedback` | `MessageFeedbackService` | `packages/feedback/message-feedback/src/index.ts:56` |

**Interaction / runtime services**
| name | type | site |
|---|---|---|
| `settings` | `SettingsProvider` | `packages/settings/settings/src/index.ts:133` |
| `credentials` | `CredentialProvider` | `packages/credentials/credentials/src/index.ts:157` |
| `authorization` | `AuthorizationService` | `packages/credentials/authorization/src/index.ts:45` |
| `approval` | `ApprovalService` | `packages/interaction/user-approval/src/index.ts:19` |
| `userQuestions` | `UserQuestionService` | `packages/interaction/user-questions/src/index.ts:16` |
| `commands` | `CommandRuntime` | `packages/interaction/commands/src/index.ts:106` |
| `permissionPresets` | `PermissionPresetService` | `packages/interaction/permission-presets/src/index.ts:38` |
| `shell` | `ShellExecutor` | `packages/shell/shell/src/index.ts:42` |
| `shellEnv` | `ShellEnvRegistry` | `packages/shell/shell-env/src/index.ts:21` |
| `subprocess` | `SubprocessRuntime` | `packages/subprocess/subprocess/src/index.ts:70` |
| `jobs` | `JobRegistry` | `packages/jobs/jobs/src/index.ts:31` |
| `fs` | `FileSystem` | `packages/fs/fs/src/index.ts:46` |
| `sandbox` | `SandboxProvider` | `packages/sandbox/sandbox/src/index.ts:148` |
| `sandboxPolicy` | `SandboxPolicyService` | `packages/sandbox/sandbox-policy/src/index.ts:56` |
| `terminals` | `TerminalSessionService` | `packages/terminal/terminal/src/index.ts:50` |
| `lsp` | `LspService` | `packages/lsp/lsp/src/index.ts:40` |
| `workspaceRegistry` | `WorkspaceRegistry` | `packages/workspace/workspace/src/index.ts:69` |
| `invariants` | `InvariantRegistry` | `packages/runtime-diagnostics/invariants/src/index.ts:70` |
| `typert` | `TypertRegistryContract` | `packages/typert/protocol/src/types.ts:489` |
| `web` | `WebRuntime` | `packages/web/web/src/index.ts:37` |

**Host/web transport**
| name | type | site |
|---|---|---|
| `webServer` | `WebServer` | `packages/host/webserver/src/index.ts:24` |
| `apiProxy` | `ApiProxy` | `packages/host/apiproxy/src/index.ts:36` |
| `directoryPicker` | `DirectoryPicker` | `packages/host/directory-picker/src/index.ts:120` |
| `connection` | `HostConnectionHandle` | `packages/client/connection/src/rpc-host.ts:38` |
| `typertGateway` | `TypertGateway` | `packages/api/gateway/src/types.ts:52` |

**Boot-level (optional; may be absent)**
| name | type | site |
|---|---|---|
| `dshHomePath?` | `typeof dshHomePath` | `packages/boot/app-boot/src/index.ts:27` |
| `cmdlineArgs?` | `CmdlineArgs` | `packages/boot/cmdline/src/index.ts:47` |
| `appExit?` | `AppExit` | `packages/boot/cmdline/src/index.ts:49` |
| `launchEnvironment?` | `LaunchEnvironmentSnapshot` | `packages/util/launch-environment/src/index.ts:122` |
| `dynamicCordisRunner` | `DynamicCordisRunnerService` | `packages/extensions/cordis-host-runner/src/index.ts:83` |
| `cordisInspect` | `CordisInspectRegistryService` | `packages/extensions/cordis-host-runner/src/inspect-registry.ts:41` |

**Not found:** `grep -rn "inject = \[.*(schedule|httpServer|bus)" packages --include=*.ts` — there is
no `schedule` service on `Context`; `packages/schedule/schedule/src/index.ts:35` declares
`inject = ['agents', 'sessions', 'tools', 'sessionPersistence']` and provides none of the names
above. Confidence: verified-by-code (enumeration is complete for non-test `src/` files).

### 2.3 Registering agent-side TOOLS

API: `ctx.tools.register(definition: ToolDefinition): () => void` —
`packages/core/tools/src/index.ts:1037`. Returns the disposer; registration is an effect, so
fiber unload unregisters (`docs/cookbook/adding-a-tool.md` "Registration is effect-based").

Factory: `defineTool` — re-exported from `packages/core/tools/src/index.ts:68` (defined in
`./schema.ts`). Minimal real example, verbatim from `docs/cookbook/adding-a-tool.md:7-34`:

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

`ToolDefinition` (`packages/core/tools/src/index.ts:222-…`) extends `ToolSchema` and adds:
`output: ToolOutputDefinition` (required, `:218`), `execute(args, exec)` (`:228`),
`finalizeContent?` (`:241`), `timeoutMs?` (`:250`), `isConcurrencySafe?` (`:262`),
`presentCall?(args): ToolCallView | undefined` (`:275`),
`presentResult?(args, result): ToolResultView | undefined` (`:285`).
`ToolOutputDefinition` = `{ schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }` — `:206-213`.

Other `ToolRuntime` methods: `restrict(filter: ToolRestriction): () => void` `:1071`,
`get(name, scope?)` `:1204`, `schemas(scope?): ToolSchema[]` `:1234`.

**JSON-Schema constraints — `assertSupportedJsonSchema(schema): asserts schema is JsonSchemaNode`**
`packages/core/tools/src/json-schema.ts:385-389`; throws `JsonSchemaError`
(`:66-75`, code `UNSUPPORTED_SCHEMA`, message `unsupported JSON schema: <all violations joined by "; ">`)
listing **every** offending path, not the first.

The accepted subset is closed (`json-schema.ts:1-11` header + `JsonSchemaNode` `:32-56`):
- `type` — a **single** string from `'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'`
  (`SCHEMA_TYPES` `:87`). Type **arrays are rejected**: `json-schema.ts:303-307`.
- `oneOf` — array of **≥ 2** branches, exact-one semantics (`:291-296`); sibling keywords beside
  `oneOf` are rejected except the `ONE_OF_SIBLING_KEYWORDS` set (`:236`).
- `properties` / `required` / `additionalProperties` — **`type: 'object'` only**
  (`allowedFor` map, `:310-318`). `additionalProperties: false` rejects undeclared keys;
  absent/`true` is the JSON-Schema open default (`:41`).
- `items` — **`type: 'array'` only** (`:314`).
- `enum` / `const` — scalar types only (`:312-313`); values are `string | number | boolean | null` (`json-schema.ts:21`).
- Annotations only: `description`, `title`, `default`, `examples` (`ANNOTATION_KEYWORDS` `:86`);
  `default`/`examples` must be lossless JSON (`:51-55`).
- **Anything else rejects rather than being silently unenforced** (`:8-9`).
- `assertObjectJsonSchema` (`:397-405`) = same subset + requires root `type: 'object'`
  (used by subagent/workflow structured output).

`defineTool`'s own `parameters` DSL (`ParameterSchemaSpec`) is *not* raw JSON Schema; it is
converted by `parameterSchemaSpecToJsonSchema` (`packages/core/tools/src/index.ts:69`).

Confidence: verified-by-code.

### 2.4 Getting text into the model each turn — the real mechanisms

There is **no** "conversation middleware" and **no** `before-turn` event by that name.
(`grep -rn "before-turn\|beforeTurn\|conversation middleware" --include=*.ts packages` → no hits.)
Four distinct sanctioned seams exist:

**(a) `ctx.systemPrompt` — the per-assembly registry (the main one).**
Service class `SystemPrompt` — `packages/core/system-prompt/src/index.ts:338`; `super(ctx, 'systemPrompt')` `:354`.
Event `'system-prompt/assemble'` is a **waterfall** over the whole assembly — `:29`.
Registration methods, all returning the Cordis effect disposer:

```ts
section(section: PromptSection): () => void                 // :381
context(context: PromptContext): () => void                 // :398
suppressRuntimeContext(): () => void                        // :413
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void  // :427
variable(...)                                               // :435+
```

`PromptSection` (`:52-75`) = `{ name, order, text: string | ((ctx) => string), complete? }`.
Order convention, from the JSDoc at `:57-61`: **`-100` harness identity, `0` deployment persona,
tool guidance `100–199`**. Duplicate `name` in one scope throws (`:53`, and `:379-380`).
`complete: true` makes that section the *entire* prompt and suppresses the rest (`:66-73`);
more than one effective complete section fails assembly.

`PromptContext` (`:77-84`) = `{ name, order, text }` — "Dynamic model context materialized as a
**durable user-role snapshot**" (`:76`). This is the KV-cache-friendly route: DSH only re-appends
when the rendered text changes. Real call, `packages/subagent/subagent/src/child-agent.ts:170`:
```ts
childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, text: SUBAGENT_DELEGATION_CONTEXT })
```
Real `section` call, `packages/extensions/tool-cordis/src/index.ts:36`:
```ts
ctx.systemPrompt.section({ name: 'tool:cordis', order: 115, text: CORDIS_SYSTEM_PROMPT })
```
Config of the service: `includeHarnessIdentity`, `includeRuntimeContext`, `persona`, `toolOrder`
— `packages/core/system-prompt/src/index.ts:339-345`.

**(b) `agent.inject(message)` — durable context for the NEXT request.**
`packages/core/agent/src/runtime-types.ts:136-143`:
> "Queue model-facing context for the next pre-step without waking the driver. A running driver
> claims it at the nearest later step boundary; idle drivers leave it pending until follow-up or
> steering wakes them. … Cancellation or disposal may discard pending context."

Sibling verbs on the same interface: `followup(message)` `:124`, `steer(message)` `:133`.
`UserMessage` content carries a `source`, and the plugin source tag is
`{ kind: 'plugin', plugin: '<name>' }` — see `docs/cookbook/adding-a-tool.md` ("Use `exec.agent`
for async notifications … it is not a wake-up (an idle agent stays idle)").

**(c) `agent/pre-step` — the per-step waterfall (veto / replace messages).**
`packages/core/agent/src/runtime-types.ts:231`:
```ts
'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```
Mode **waterfall** (`:229`). Emitted at `packages/core/agent-loop/src/agent.ts:235`.

**(d) `agent/request` — replace the frozen LLM call config.**
`packages/core/agent/src/runtime-types.ts:244`:
```ts
'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
```
JSDoc `:237-243`: "**Model-visible content must use logged channels; this waterfall cannot mutate
messages.**" Emitted at `packages/core/agent-loop/src/agent.ts:459`; real consumer
`packages/core/agent/src/model-selection.ts:55`.

Full agent event roster in the same file — `agent/created` `:157`, `agent/disposed` `:168`,
`agent/status` `:131`, `agent/inbox/inserted` `:142`, `agent/inbox/claimed` `:155`,
`agent/inbox/discarded` `:163`, `agent/session-start` `:175`, `agent/pre-step` `:231`,
`agent/request` `:244`, `agent/request-error` `:258`, `agent/turn-stopping` (~`:272`).

Tool pipeline events (`packages/core/tools/src/index.ts:141-206`): `tools/pre-execute` (waterfall,
allow/deny/ask) `:151`, `tools/execute` (around-dispatch waterfall: timeout/retry/metrics) `:162`,
`tools/post-execute` (waterfall; "replace presentation content or the returned value, block the
result, or **attach model-facing context**") `:174`, `tools/code-dispatch-log` `:187`,
`tools/result` (emit) `:196`, `tools/change` (emit) `:205`.

Confidence: verified-by-code.

## 3. Client-side plugin API

### 3.1 Packaging a client half

One package, two halves: Node half under `src/`, browser half under `src/client/`, exported as
`./client`. `docs/cookbook/adding-a-settings-card.md:4`:
> "The two halves live in one package — the Host half under `src/`, the browser half under
> `src/client/`, exported as `./client` and declared with `dsh.client`."

Real manifest (`packages/client/ui-trajectory/package.json:14-42`):
```json
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    ...
  },
  "dsh": { "client": { "inject": [ "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation" ], "platform": "web" } }
```

The host entry must still exist and be mounted by a loader row: browser bundles are discovered
from the **enabled Loader entries**, so a `cordis.yml` row for the package is what puts the
browser half on the page (`docs/cookbook/adding-a-settings-card.md:87-90`).

### 3.2 The bundle-purity rule (hard, build-time)

`packages/client/tsdown.client.ts:472-495` — plugin `dsh-client-bundle-purity`:
```ts
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null // requested module-table row: external wins
        if (VENDORED_LIBRARY.test(source)) return null // inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)')
      }
```
Consequences for a plugin author:
- **Cross-plugin imports must be `import type {}` / `import type {} from '…'`.** Real convention,
  e.g. `packages/client/ui-trajectory/src/client/index.ts:8-12`:
  ```ts
  // Type-only: pulls the locale plugin's Context merge (ctx.locale).
  import type {} from '@deepseek-ai/dsh-client-locale/client'
  // Type-only: the 'conversation.view' SlotMap row (declared by the slot's owning package)
  import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
  ```
- Default module-table externals (shared identity), `packages/client/web/src/platform.ts:8-17`:
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, plus preloaded
  `@deepseek-ai/dsh-client-runtime/client`.
- Anything else you want shared must be listed in `dsh.client.external`
  (`tsdown.client.ts:401-406`; matched **exactly, never normalized** — `:390-391`).
- Inline-safe value-importable wire layers (`tsdown.client.ts:61`):
  `/^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand)(\/|$)/`.
- Vendored libraries you may inline: `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery` (`:69`).
- Generated remote descriptors may be inlined: `GENERATED_REMOTE` = `.../remote` subpath (`:72`).
- CSS: `.css` imports are rewritten to a style-injector module keyed
  `` `${id}/${basename(fileId)}` `` — `tsdown.client.ts:33-44`. Non-default deps are bundled
  (`alwaysBundle: specifier => !isRequested(specifier)`, `:463`), and `process.env.NODE_ENV` /
  `import.meta.env` are `define`d because a CJS browser bundle cannot carry them (`:465-481`).

### 3.3 Slots a plugin can mount

Registration API — `SlotRegistry` (`ctx.slots`, declared `packages/client/runtime/src/client/index.ts:170`).
Two methods:

```ts
// packages/client/runtime/src/client/slots.ts:143
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
// packages/client/runtime/src/client/slots.ts:126 (re-exported prototype method)
declare readonly register: SlotCore['register']
```

`register` contracts (`packages/client/ui-slots/src/index.ts:706-736`):
- registering into an **undeclared** slot throws (`:789-792`: `slot "…" is not declared (a parent
  entry's children table must declare it)`)
- **single** / **keyed** (same `key`) / **list** (same `id`) cells shadow by `priority` ascending,
  ties keep registration order, and **the lowest live entry renders**; a second registration at an
  occupied cell's exact priority (default `0`) **throws naming the occupant** (`:720-726`, message built `:796-798`)
- `keyed` requires `key`, `list` requires `id`, `chain` requires `select` (`:712-715`)
- declaring an already-declared child key throws; one shared store handle under two scopes throws
- the disposer removes the contribution **and recursively collapses every child slot it declared** (`:728-731`)

Do not register into `'root'` — the JSDoc at `packages/client/runtime/src/client/slots.ts:26-41`
says it plainly: it is `single`, already occupied by ui-layout's AppFrame, and a dynamically
registered entry wins the shadowing comparison and blanks the whole app. For a floating surface,
use `'shell.overlay'` (a `list`, click-through until you opt into pointer events).

**Complete slot inventory** (every `interface SlotMap` merge in `packages`, minus tests):

| slot | kind | scope | declared at |
|---|---|---|---|
| `root` | single | root | `packages/client/runtime/src/client/slots.ts:41` |
| `sidebar` | single | root | `packages/client/ui-layout/src/client/index.ts:49` |
| `conversation` | single | session-maybe | `packages/client/ui-layout/src/client/index.ts:62` |
| `details` | single | session | `packages/client/ui-layout/src/client/index.ts:72` |
| `shell.overlay` | list | root | `packages/client/ui-layout/src/client/index.ts:83` |
| `conversation.session` | single | session | `packages/client/ui-conversation/src/client/contract/slots.ts:71` |
| `conversation.session.header` | single | session | `…/slots.ts:79` |
| `conversation.session.header.lineage` | — | — | `…/slots.ts:85` |
| `conversation.session.header.actions` | list | session | `…/slots.ts:100` |
| `conversation.session.header.utilities` | list | session | `…/slots.ts:105` |
| `conversation.view` | list | session | `…/slots.ts:113` |
| `conversation.chat.node` | — | — | `…/slots.ts:115` |
| `conversation.message.images` | single | session | `…/slots.ts:124` |
| `conversation.chat.commandview` | keyed | session | `…/slots.ts:133` |
| `conversation.chat.assistant-actions` | — | — | `…/slots.ts:148` |
| `conversation.details.tool` | single | session | `…/slots.ts:163` |
| `conversation.composer` | chain | session | `…/slots.ts:171` |
| `conversation.hero.workspace` | single | root | `…/slots.ts:178` |
| `conversation.hero.brand.mark` | single | root | `…/slots.ts:183` |
| `conversation.input.dock` | list | session | `…/slots.ts:205` |
| `conversation.composer.dock` | list | session | `…/slots.ts:214` |
| `conversation.input.left` | list | session | `…/slots.ts:223` |
| `conversation.input.right` | list | session | `…/slots.ts:231` |
| `conversation.composer.bar` | single | session-maybe | `…/slots.ts:245` |
| `conversation.input.attachments` | — | — | `…/slots.ts:247` |
| `conversation.input.plan` | single | session | `…/slots.ts:261` |
| `conversation.input.model` | single | session | `…/slots.ts:271` |
| `conversation.input.overlay` | list | session | `packages/client/ui-input-trigger/src/client/slots.ts:24` |
| `tool.call.toolview` | keyed | session | `packages/client/ui-tool/src/client/contract/slots.ts:24` |
| `tool.view.cordis` | keyed | session | `packages/extensions/ui-cordis/src/client/slots.ts:31-34` |
| `settings.trigger` | single | root | `packages/client/ui-settings/src/client/contract/slots.ts:23` |
| `settings.header` | single | root | `…/slots.ts:29` |
| `settings.action` | list | root | `…/slots.ts:35` |
| `settings.close` | single | root | `…/slots.ts:41` |
| `settings.section` | list | root | `…/slots.ts:53` |
| `settings.plugins.tab` | list | root | `…/slots.ts:62` |
| `settings.onboarding` | list | root | `…/slots.ts:73` |
| `settings.general.item` | list | root | `…/slots.ts:88` |
| `settings.plugin.item` | keyed | root | `packages/client/ui-settings-plugins/src/client/slot-contract.ts:19` |

`sidebar.brand.mark` `:23`, `sidebar.brand.name` `:28`, `sidebar.workspaces` `:35`,
`sidebar.settings` `:41`, `sidebar.footer.action` `:46` —
`packages/client/ui-sidebar/src/client/contract/slots.ts`.

To add your own sub-slots you declare them in the `children` table of your `register()` call
(declaration = render authorization = runtime spec — `packages/client/ui-slots/README.md:1-12`).

**Minimal real example** (`packages/client/ui-trajectory/src/client/index.ts:43-63`):
```ts
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'trajectory',
  order: 10,
  locale: NS,
  label: () => t('view.trajectory'),
  inject: (sessionId: SessionId): TrajectoryViewInjected => { /* … */ },
}, TrajectoryView))
```
Settings-page example (`docs/cookbook/adding-a-settings-card.md:49-63`):
```ts
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']
export function apply(ctx: ClientContext): void {
  const card = new MyPluginCardController(ctx.settingsScope.bind({ namespace: 'my-plugin' }))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'my-plugin',
    locale: 'settings.myPlugin',
    inject: () => card.inject(),
  }, MyPluginCard))
}
```
Generator-style registration with `yield` for multiple disposers: `packages/client/ui-brand-official/src/client/index.ts:19-21`,
`packages/client/ui-settings-plugins/src/client/index.ts:147-159`.

### 3.4 Locale contributions

Service `ctx.locale` (`LocaleRuntime`) — `packages/client/locale/src/client/index.ts:74`.
```ts
register(ns: string, locale: string, dict: LocaleDict): () => void      // :253
register(ns: string, localeOrDicts: string | Record<string, LocaleDict>, dict?: LocaleDict): () => void  // :254
bind(ns: string): Translate                                             // :301
```
`ns` is typed against the merge-extensible `LocaleNamespaceMap`
(`packages/client/locale/README.md:7`; merge sites: `packages/client/ui-trajectory/src/client/locales.ts:24`,
`packages/client/ui-goal/src/client/index.ts:31`, `packages/client/ui-deliverables/src/client/index.ts:21`, …).
Real registration, `packages/client/ui-trajectory/src/client/index.ts:31`:
```ts
ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-trajectory: dictionaries')
```
Lookup chain: `ns → common → en → key` (`packages/client/locale/README.md:7`).
`locale/change` fires on switches (`packages/client/locale/src/client/index.ts:73` region).
Gotcha recorded in the package README ("Known Limitations"): **registry-held text reads its
translation once** — copy captured at registration time outside the slot render path keeps its
language until re-registration; pass a **thunk** (`label: () => t(...)`) to follow switches live,
as `ui-trajectory/src/client/index.ts:34-36` does.

### 3.5 Reaching host RPC from the client

Three sanctioned routes, in descending order of preference for a plugin.

**(A) Typert Remote (recommended: typed, generated, rides `/api`).**
A host service marks methods `@Remote('<name>')` on a class extending `TypertRemoteService`
(or `bindTypertRemote(this, serviceKey)`), and the shared Gateway exposes them as
`POST /api/<namespace>/<method>`. Declarations:
- `packages/typert/protocol/README.md:9-16` — "`@Remote` marks a public instance method for direct
  invocation on its registered Cordis Service", `@RemoteScope(key)`, `TypertRemoteService` binds
  the Cordis key to the default wire namespace, `bindTypertRemote(this, serviceKey, options?)`,
  `remoteMethods(service)`.
- Cooperative cancellation: "A Host method opts into cooperative cancellation by declaring
  `signal: AbortSignal` as its final parameter" — same README, `:17-20`.
- Real in-box example — `packages/feedback/message-feedback/src/index.ts:147-190`:
  ```ts
  export class MessageFeedbackService extends TypertRemoteService {
    static inject = ['storageDomain', 'sessionPersistence', 'sessions']
    constructor(ctx: Context, config: Config) { super(ctx, 'messageFeedback') /* … */ }
    @Remote('list')
    async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> { … }
  ```
- The Gateway claims those endpoints by intercepting the shared `/api` channel —
  `packages/api/gateway/src/index.ts:104-111`:
  ```ts
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.intercept(
      '/api',
      endpoint => this.claimsEndpoint(endpoint),
      (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal),
      { authority: 'trusted-host' },
    )
  })
  ```
- Client consumer: `ctx.remote` (`ClientRemote` / `TypertClientRemote`) —
  `packages/api/gateway/src/client/index.ts:69`, `packages/api/remotes/src/client/index.ts:101`.
  It also carries `$on` for forwarded host events and `$dispatch`.

**(B) `ctx.connection.rpc.call(channel, endpoint, payload, signal)`** —
`packages/client/connection/src/rpc.ts:62-77`. Real usage:
`packages/client/connection/tests/fixture-commands.client.spec.ts:19`:
```ts
const result = await rpc.call('/api', endpoint, { args })
```
Client handle shape — `packages/client/connection/src/client/index.ts:85-103`:
`{ api: IApiClient, isLoopback: boolean, hostDescription: HostDescriptionSource, rpc: ClientConnectionRpc, start(...) }`.
Obtained as `const { api } = ctx.get('connection') as ConnectionHandle` —
`packages/client/ui-settings-plugins/src/client/index.ts:58`.

**(C) Plain `fetch()` to your own `webServer` prefix route.** The route the reference third-party
plugin uses: `dsh-memory-evolve/src/client/index.*` → `fetch('/memory-evolve/api/config')`, backed
by `dsh-memory-evolve/lib/api.js:846`:
```js
return ctx.webServer.register({ kind: 'prefix', path: '/memory-evolve', handler })
```
Simplest, but carries **no** trust fence (see §4.3).

**A plugin cannot add methods to `RpcMethodMap`.** It is a closed literal interface —
`packages/host/apiproxy/src/api/rpc-map.ts:24-76` — with no `declare module` merge, and its
`UNARY_VALUE_SCHEMAS` table is `{ [K in keyof RpcMethodMap]: … }`
(`packages/host/apiproxy/src/fetch/client.ts:168`), so a missing row is a compile error.
Verified by `grep -rn "interface RpcMethodMap" --include=*.ts packages` → exactly one hit.
Consequence: a plugin's host-side surface is either Typert Remote (A) or its own HTTP route (C).

**Sessions RPC roster** (`packages/host/apiproxy/src/api/rpc-map.ts:25-36`, served as
`POST /api/<method>` per `rpc-map.ts:4`):
`session.list`, `session.search`, `session.create`, `session.history`, `session.models`,
`session.selectModel`, `session.rename`, `session.fork`, `session.prompt`, `session.attachment`,
`session.updateQueue`, `session.cancel`.
Request/response zod schemas: `packages/host/apiproxy/src/api/sessions.schema.ts`
(e.g. `sessionListRequestSchema` `:65`, `sessionListValueSchema` `:69`,
`sessionSearchRequestSchema` `:77` capped at `SESSION_SEARCH_QUERY_MAX_CHARS = 500` `:74`).
Client method surface: `IApiClient.sessions.*` — `packages/host/apiproxy/src/fetch/client.ts:88-101`.
There is **no** `session.status` method; live status rides the `host/session-status` push frame
(`packages/host/apiproxy/README.md`, and `session.list` rows carry `running: boolean` —
`sessions.schema.ts:57`).
Other namespaces on the same channel: `subagent.*` (`rpc-map.ts:37-40`), `host.*` `:41-45`,
`workspace.*` `:46-52`, `skill.list` `:53`, `agentPreset.*` `:54-59`, `goal.*` `:60-65`,
`settings.*` `:66-70`, `credentials.*` `:71-73`, `llm.*` `:74-76`.

Confidence: verified-by-code.

## 4. webServer route registration

### 4.1 `ctx.inject(['webServer'])` shape

`webServer` is optional at the composition level (a TUI/CLI headless profile mounts no HTTP
server), so the sanctioned pattern is a nested injection, not a top-level `inject`.
Real in-box consumer: `packages/client/connection/src/index.ts:171`
```ts
ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
```
Real third-party plugin pattern — `dsh-memory-evolve/lib/index.js:1751`:
```js
// 4. Web API: the settings panel's data surface (web-only service; the
//    plugin still loads on surfaces without httpServer).
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => installApi(webCtx, { … }))
})
```
and `dsh-memory-evolve/lib/api.js:846`:
```js
return ctx.webServer.register({ kind: 'prefix', path: '/memory-evolve', handler })
```
`ctx.inject(deps, callback)` is `registry.ts:300-302`: the callback runs only while the service
exists, is unloaded/reloaded with it, and its `ctx` is a child fiber — so anything registered on
`webCtx` is torn down when `webServer` disappears. Prefer this over putting `webServer` in the
module-level `export const inject`, which would make your *whole* plugin unload on headless
surfaces.

Service: `class WebServer extends Service`, `super(ctx, 'webServer')` —
`packages/host/webserver/src/index.ts:73-89`.

### 4.2 Registration API and collision rules

```ts
// packages/host/webserver/src/index.ts:110  -> () => void
register(route: WebRoute): () => void
// :123 -> () => void
registerUpgrade(route: WebUpgradeRoute): () => void
// :137 -> () => void
registerFallback(handler: WebRoute['handler']): () => void
// :150 -> () => void
tapIndex(transform: (html: string) => string): () => void
```
`WebRoute` (`:40-47`): `{ kind: 'exact' | 'prefix'; path: string /* absolute, no trailing slash */;
handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`.
`WebUpgradeRoute` (`:50-57`): `{ path; handler(req, socket: Duplex, head: Buffer) }`.
`Config` (`:60-66`): `{ host: '127.0.0.1' | '0.0.0.0'; port: number /* 0 = OS-assigned */ }`,
schema `:75-78` (`z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required()`,
`z.natural().max(65535).required()`). Accessors `port` `:93` and `host` `:98`.

**Collision rules (all throw at register, i.e. a FAILED fiber, not a silent shadow):**
- `register` — duplicate **`(kind, path)`**: `webserver: duplicate ${route.kind} route "${route.path}"`
  (`:110-116`). Exact and prefix tables are separate Maps, so an `exact` and a `prefix` row may
  share a path string.
- `registerUpgrade` — duplicate exact path: `webserver: duplicate upgrade route "${path}"` (`:123-129`).
- `registerFallback` — **one owner only**: `webserver: fallback already registered` (`:137-145`).
- Route order never matters; dispatch is exact-table hit → longest-prefix-wins (`match()` `:255-…`).
- An unmatched request with no fallback is a bare `404` with an empty body (`:170-175`).

Disposers returned by these four methods remove the registration; `register`/`registerUpgrade`/
`registerFallback`/`tapIndex` all return plain closures that delete/unset, so wrap them in
`ctx.effect(...)` (or call inside a `ctx.inject` callback, whose fiber owns them).

### 4.3 Same-origin / auth — what exists and what does NOT

**Verified absent in `@deepseek-ai/dsh-host-webserver`:**
```
grep -rniE "origin|cors|authoriz|bearer|cookie|session-token|401|403" packages/host/webserver/ --include=*.ts
→ 0 hits (also 0 hits for "Access-Control")
```
The carrier "Knows no harness concepts and serves no files"
(`packages/host/webserver/src/index.ts:2-8`). Its own doc states the posture,
`docs/subsystems/web-server.md:41`:
> "`host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure);
> **there is no TLS, auth, or origin policy**, so a non-loopback bind exposes the server to that network."

**What DOES exist** is a fence that lives in a *different* package and applies only to `/api`:
`@deepseek-ai/dsh-client-connection`
(`packages/client/connection/src/api-request-trust.ts`). Its header `:1-13`:
> "Browser-trust fence for every /api request. Defends the two confused-deputy paths a browser
> opens against a local HTTP API — DNS rebinding … and cross-site requests fired from a malicious
> page. … **Network reachability and authentication stay out of scope**: binding policy belongs to
> the webserver config, and **this fence is not an auth layer**."

How it is wired (`packages/client/connection/src/index.ts:161-172`): the `/api` **prefix** route
wraps its own handler with `if (!isTrustedApiRequest(req, trustedHosts)) → 403 forbidden`.
Additionally, a hard-coded `PRIVILEGED_METHODS` set (`:87-117`) is checked against an **empty**
trust list (`isTrustedApiRequest(request, [])` at `:147`), pinning those methods to loopback:
`agentPreset.read/copy/openDocument/remove`, `host.pickDirectory`, `host.openPath`,
`settings.describe/openDocument/update/replace/mutate`, `credentials.describe/set/unset`,
`llm.discoverModels`. WebSocket downlinks re-check the same way (`:183-187`).
Rationale at `:73-79`: "`trustedHosts` is a DNS-rebinding fence, **explicitly not authentication**,
so the whole configuration plane stays loopback-same-origin **until a real authentication layer
exists**."

The fence reads `Host` (always) plus browser markers when present
(`api-request-trust.ts:93-110`); non-browser clients pass via loopback, deployment-derived LAN IP
literals, or a declared `trustedHosts` authority. `trustedHosts` entries are validated at load —
`assertTrustedAuthority` throws `client-connection: trustedHosts entry … is not a bare
host[:port] authority` (`:52-57`) — and CLI `--trusted-host` feeds them
(`packages/bundle/web-app/src/startup.ts:54,84`; `resolveLanTrust` at
`packages/bundle/web-app/src/index.ts:132-139`).

Also enforced on `/api`: **every POST must declare `application/json`** or it is refused `415`
before dispatch, "so cross-site 'simple' requests (which browsers send without a CORS preflight)
can never execute a side-effectful method blind" — `packages/host/apiproxy/README.md:19`.

**Consequence for a plugin that registers its own route:** your route is outside `/api`, so
**none** of the above applies to it. It is anonymous, cross-origin-readable-by-`no-cors`-opaque,
DNS-rebinding-able, and reachable by any page the host can be fetched from when bound `0.0.0.0` —
and by any local process when bound `127.0.0.1` (no OS-level peer-credential check exists here).

### 4.4 What a plugin must do to be safe

Derived obligations (there is no host-provided guard to inherit):
1. **Prefix-isolate** your path (`/my-plugin/…`) and never `registerFallback` — one owner, and the
   shipped web composition's fallback is the SPA dist server.
2. **Re-check authority yourself on every mutating/CORS-relevant route.** The mechanism you can
   reuse is `isTrustedApiRequest(request, trustedHosts)` exported from
   `@deepseek-ai/dsh-client-connection` (`api-request-trust.ts:96`) — but note `trustedHosts` is a
   *deployment* value owned by the connection plugin's config, so a plugin either reads it from
   its own config or pins to loopback. In-box precedent for a plugin owning its own fence:
   `packages/client/connection/src/rpc-host.ts:82` (`authority: 'loopback'` interceptor →
   `isTrustedApiRequest(request, [])`).
3. Prefer **`ctx.connection.rpc.handle(channel, handler, { authority })` /
   `.intercept('/api', matches, handler, { authority })`**
   (`packages/client/connection/src/rpc.ts:33-52`) over a raw `webServer` route: the trust policy
   is then declarative (`'trusted-host' | 'loopback'`, `rpc.ts:6`) and Connection applies the
   fence for you. This is the sanctioned way to add a *new* RPC channel — and the Gateway is the
   in-box consumer of `intercept` (`packages/api/gateway/src/index.ts:104-111`).
   Host enforcement of that policy is at `packages/client/connection/src/rpc-host.ts:82`
   (`authority === 'loopback'` → `isTrustedApiRequest(request, [])`) and `:103`.
4. **Bound the request body.** The connection layer's default is
   `DEFAULT_MAX_REQUEST_BODY_BYTES` (config `maxRequestBodyBytes`,
   `packages/client/connection/src/index.ts:61-66`); a raw `webServer` route has no cap at all.
5. Do not trust `Origin` alone; per `api-request-trust.ts:5-9`, over plain HTTP a browser attaches
   neither `Origin` nor `Fetch-Metadata` to reads, which is exactly why the `Host` header is the
   load-bearing check.
**A worked third-party guard already shipped on this host** — `dsh-free-search`
(`dsh-free-search-chain/lib/index.js:1480-1490`, `:1221-1241`). It is the closest thing to a
template, and note it checks the **socket peer** (`remoteAddress`), which the host's own `/api`
fence deliberately does not:
```js
const guard = (req, res) => {
  if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: "loopback requests only" }); return false }
  if (req.method !== "POST")   { writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") }); return false }
  return true
}
// :1221
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false
  const host = request.headers.host
  if (typeof host !== "string") return false
  let hostUrl; try { hostUrl = new URL("http://" + host) } catch { return false }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false
  if (request.headers["sec-fetch-site"] === "cross-site") return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}
```
Its routes are `kind: 'exact'` under a private prefix `"/api/dsh-free-search-settings"`
(`:46`, `:1492-1570`) — **legal but a bad precedent**: `/api` is registered as a **prefix** route by
client-connection (`packages/client/connection/src/index.ts:161-172`), so your
`exact /api/<yours>/…` path silently wins the longest-prefix dispatch
(`packages/host/webserver/src/index.ts:255`) while carrying **none** of the fence, the 415 media-type
gate, or the body cap. Use your own top-level prefix (`/my-plugin`) instead.
Registration idiom to copy (`:1887-1899`): `ctx.inject(["webServer", "settings"], sctx =>
sctx.effect(() => { const disposers = routes.map(r => sctx.webServer.register(r));
return () => disposers.forEach(d => d()) }))` — one effect, N disposers, serial teardown in one
disposer, per §6.1's no-serial-async-disposers caveat.

**Failure posture of the carrier you inherit:** a handler that rejects is caught per-request,
logged `warn`, and answered `400` (or `res.destroy()` if headers were already sent) — never a
process exit (`packages/host/webserver/src/index.ts:177-191`). Upgrade-handler throws destroy the
socket (`:206-217`).

Confidence: verified-by-code (negatives backed by the 0-hit greps above).

## 5. Persistence & config delivery

### 5.1 The harness home

`@deepseek-ai/dsh-home-paths` (`packages/util/home-paths/src/index.ts`):
- `DSH_HOME_DIR_NAME = '.dsh'` `:12`; `DSH_HOME_ENV = 'DSH_HOME'` `:18`
- `defaultDshHome()` = `join(homedir(), '.dsh')` `:62`
- `resolveDshHome(configured?, env = process.env)` `:87-92` — precedence **explicit configured →
  `$DSH_HOME` → `~/.dsh`**; a blank/whitespace `$DSH_HOME` counts as unset (`:87-91`)
- `dshHomePath(...segments)` `:98-100` — the sanctioned join helper
- `dshHomeDisplay()` `:108-112` — never leaks an absolute path into UI copy
- `expandHomePath()` `:70-75` — `~`, `~/`, `~\`
- `canonicalizeWatchPath()` `:29-57` — required before handing a path to a native FS watcher

The root context **provides** the function as a service: `ctx.provide('dshHomePath', dshHomePath)`
— `packages/boot/app-boot/src/index.ts:770`, typed optional at `:27`
(`dshHomePath?: typeof dshHomePath`). That is what makes `!!js dshHomePath('storages')` legal
inside a patch YAML — see §5.3.

Observed live layout (`ls /home/administrator/agent-workspace/.dsh/`):
`AGENTS.md`, `settings.yaml`, `.credentials.yaml`, `.env`, `.anonymous-user-id`,
`attachments/`, `cache-baseline/`, `context-mode-data/`, `dsh-telegram/`, `integrations/`,
`MANUAL/`, `profiles/`, `sessions/`, `skills/`, `storages/`, `.agent-presets/`.

### 5.2 Is there a *sanctioned per-plugin* data dir? — No.

**Not-found, with the searches.** `dshHomePath(` appears at exactly two non-test call sites in all
of `packages/` — its own definition (`packages/util/home-paths/src/index.ts:98`) and
`packages/preset/agent-presets/src/index.ts:134`.
`grep -rn "resolveDshHome|dshHomePath|DSH_HOME" --include=*.ts packages` (non-test) returns only:
`home-paths`, `settings-file` (`:56`), `agent-instructions` (`config.ts:106`),
`llm-deepseek` (`upload-index.ts:117`), `examples/agent-spine-demo`, and
`extensions/anti-slop-shadow` (`cache-baseline.ts:61`, which hand-rolls
`${process.env.DSH_HOME || $HOME/.dsh}/cache-baseline/…`).
There is **no** `pluginDataDir(id)`, no `$DSH_HOME/plugins/<id>/` convention enforced by the host,
and no registry of plugin-owned directories.

The two *patterns* in-box plugins actually use, both of which a third-party plugin may copy:

**(a) A `dshHome?: string` config field, resolved in code, subdir owned by the plugin.**
- `packages/settings/settings-file/src/index.ts:56`
  `resolve(config.path ?? join(resolveDshHome(config.dshHome), 'settings.yaml'))`
- `packages/attachment/attachment-local/src/index.ts:52-53` + schema `:136` `dshHome: z.string()`
- `packages/context/agent-instructions/src/config.ts:19,106`
- `packages/llm/llm-deepseek/src/upload-index.ts:117` (`DSH_HOME/llm-deepseek/files-v3.json`)
The convention is therefore **one subdirectory or file named after the plugin under the home**,
declared as `dshHome` in config so a deployment can retarget it. The reference plugin does the
equivalent with a `memoryDir` config (`dsh-memory-evolve/lib/index.js:1760` passes
`fallbackDir: config.memoryDir`).

**(b) The `storage` / `storageDomain` KV seam — the only API-backed persistence.**
- Hub `ctx.storage` (`Storage`, `packages/storage/storage/src/index.ts:47-56`), `super(ctx, 'storage')` `:53`.
  Backends register on `storage.backend` (`:49`); `mount(form, facility)` throws
  `duplicate-mount` (`:64-67`); `form(name)` throws `form-not-mounted` (`:77-82`).
- Data form `ctx.storage.domain` / `ctx.storageDomain` (`DomainFacility`,
  `packages/storage/storage-domain/src/index.ts:69`; Context merges at `:31-37`).
  `open(spec)` rejects a name already open (`already-open`), an unrouted backend
  (`backend-not-found`), a backend lacking `kv` (`facet-unsupported`), and a stored record that
  fails its zod schema (`invalid-record`) — `:84-92`.
  Config: `{ backend: string (required), routes?: Record<domainName, backendName> }` — `:50-61`.
- Real plugin usage, `packages/feedback/message-feedback/src/index.ts:173-180`:
  ```ts
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
    this.ctx.effect(() => async () => { /* drain */ await domain.close() }, 'message-feedback.domainClose')
    this.table = domain.table('sessions')
  }
  ```
  Note `inject = ['storageDomain', 'sessionPersistence', 'sessions']` at `:151`.
- Backends: `@deepseek-ai/dsh-storage-json` (one `<unit>.json` per unit under a `root`, atomic
  whole-file rewrite, `mkdir mode 0o700` — `packages/storage/storage-json/src/index.ts:1-6,22-34,63-65`)
  and `@deepseek-ai/dsh-storage-sqlite`.
- **`root` has no default on purpose** — `packages/storage/storage-json/src/index.ts:22-25`:
  "a `process.cwd()` fallback would scatter unit files wherever the process happens to start;
  assemblies state the location explicitly." So a plugin that wants the JSON backend must either
  be composed with an explicit `root` or own its own directory.

Backend availability is a *composition* fact, not a host guarantee: the shipped web bundle is what
mounts `storage`, `storage-json`, `storage-domain`
(`packages/bundle/web-app/cordis.patch.yml:51-62`). A bare `dsh-base` profile does not
(`grep -n "storage" packages/bundle/base/cordis.patch.yml` → no hits). Use
`ctx.inject(['storageDomain'], …)` or `ctx.get('storageDomain')` and degrade.

`UNIT_NAME_RE` (`packages/storage/storage/src/backend.ts`, re-exported `storage/src/index.ts:15`)
constrains unit names; the domain-layer `defineDomain`/`domainTable` spec builders are exported
from `packages/storage/storage-domain/src/index.ts:23`.

### 5.3 Config delivery

**Layer order** (`docs/user/develop/basic/publish.md` "The loading order", implemented in
`packages/boot/app-boot/src/profile.ts:1-13`):
1. each bundle patch named in `dsh.profile.bundles`, **in list order** (`@deepseek-ai/dsh-base` first)
2. the profile's own `cordis.patch.yml` (`PROFILE_PATCH_FILENAME` — `profile.ts:39`)
3. `$DSH_HOME/cordis.patch.yml` (home-level, shared by every profile)
4. each `--patch <path>` overlay, in argv order

Rules that bind a bundle author (`docs/user/develop/basic/publish.md`, "Later layers win per row"):
- a patch targets rows **by `id`**
- **a patch replaces a row's entire `config` value; it does NOT deep-merge keys.** Restate every
  key the row needs. The base patch says the same thing at
  `packages/bundle/base/cordis.patch.yml:6-7` ("A patch replaces the targeted row's whole `config`
  rather than merging into it, so a row whose value differs by mode does NOT live here").
- users can override your rows from their profile patch without touching your package, so keep
  defaults conservative.
- `disabled` also accepts a `!!js` expression evaluated against the loader context
  (`vendor/loader/src/config/entry.ts:96-104`).
- Row order carries no load semantics — activation is service-availability driven
  (`packages/bundle/base/cordis.patch.yml:12-14`).

**`!!js` expressions in config** are the mechanism that reaches host-provided values: serialized as
`{ __jsExpr: string }` (`vendor/loader/src/config/utils.ts:26-32`, `isJsExpr`), evaluated by
`new Function('ctx','expr', 'with (ctx) { return eval(expr) }')` (`utils.ts:3-9`), and applied
recursively by `interpolate(ctx, value)` (`utils.ts:13-25`). Live example of the sanctioned form —
`packages/bundle/web-app/cordis.patch.yml:57`:
```yaml
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
```
`docs/user/develop/basic/publish.md` ("Give a surface bundle its own command line") adds that the
Loader mounts the composition once, waits for each row's ordinary `inject`, and **only then**
evaluates that row's `!!js` config against its injected context — so `!!js ctx.<service>.x ?? default`
is legal beside an `inject` naming that service.

**Plugin-level schema + defaults.** Export a `Config` **interface** and a same-named Schemastery
schema; defaults live **on the schema fields**, not in code
(`docs/user/develop/basic/config.md:5-42`):
```ts
import Schema from '@deepseek-ai/schemastery'
export interface Config { greeting: string; maxRetries: number; verbose?: boolean }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})
export function apply(ctx: Context, config: Config) { console.log(config.greeting) }
```
> "Do not export a plain object as `Config`; it does not implement the Standard Schema interface
> required by Cordis." — `docs/user/develop/basic/config.md:42`

Validation runs at load; invalid config **fails the load** with an actionable error
(`config.md:57-59`). Design rule: "anything that two deployments may want to set differently [is]
a configuration field" (`config.md:76-77`). Class services declare it as
`static Config: z<Config> = …` (e.g. `packages/feedback/message-feedback/src/index.ts:154-156`,
`packages/host/webserver/src/index.ts:75-78`). Repository rule: a service package default-exports
its service class and **nothing else plugin-shaped** —
`packages/storage/storage/src/index.ts:85-89` ("mixing a default export with a function-plugin
`apply` makes the Loader drop the plugin namespace").

**Settings document layer (`ctx.settings`) — the user-editable runtime config.**
`docs/cookbook/adding-a-settings-card.md:1-4`: "Nothing in this path needs a change inside this
repository: the Host serves every registered settings namespace, and the **Plugins** section keys
its cards on the namespace they edit, so a plugin that registers both halves is paired up
automatically."
- Brand the id: `settingsNamespace(value: string): SettingsNamespace` —
  `packages/settings/settings/src/index.ts:26`.
- `SettingsProvider.register<T>(ns, schema, options?): SettingsScope<T>` — `:435`;
  duplicate namespace throws `settings namespace "…" is already registered` (`:436-438`);
  an invalid **stored** section fails the registration itself (`:430-433`); the registration is a
  fiber effect (`:444-449`). Options: `base` (composition layer), `applies: 'live' | 'restart'`,
  `validate` (`:438-443`).
- `SettingsScope<T>` = `{ get(), watch(cb), update(patch), replace(section) }` — `:~105-130`.
- **Use the helper, not the raw API**, when you already have a `cordis.yml` entry:
  `installSettingsSection(ctx, ns, schema, entry, hooks)` — `:863-869`. It does the
  `ctx.inject(['settings'], …)` gating itself (`:870`), layers the entry as `base` (`:871-873`),
  keeps working with no provider mounted, and guards `onChange` against a tearing-down fiber via
  `isUnloading(ctx)` (`:876-886`, `:889-894`).
- Events: `'settings/updated'(ns, next, prev, source)` `packages/settings/settings/src/types.ts:36`
  (deep-equal gated) and `'settings/document-updated'(ns, revision)` `:49` (raw layer, for config
  surfaces). Concurrency: `SettingsConflictError` with code `SETTINGS_CONFLICT` `:163-186`.
- Secrets: `role('secret')` on a schema field keeps its value off every response
  (`docs/cookbook/adding-a-settings-card.md:44`).
- Backing file: `<home>/settings.yaml`, hot-reloaded —
  `packages/settings/settings-file/src/index.ts:56`, `Config` at `:20-38`.

There is **no separate client-side "settings schema contribution"**: the browser card binds by
namespace string via `ctx.settingsScope.bind({ namespace })`
(`docs/cookbook/adding-a-settings-card.md:53`) and registers into the `settings.plugin.item` keyed
slot with `key` equal to that same namespace. `ctx.settingsSchema`
(`packages/client/ui-settings/src/client/schema.ts:156`) is the settings shell's own
schema/path utility service (`rehydrate` `:50`, `validate` `:60`, `nodeAtPath` `:75`,
`getPath` `:92`, `hasPath` `:111`, `setPath` `:128`, `deletePath` `:143`), **not** a contribution
point.

Confidence: verified-by-code.

## 6. Install / upgrade / uninstall lifecycle

### 6.1 `dsh plugin` is a pnpm forwarder + a manifest reconciler

`apps/cli/src/plugin.ts:1-11` (module doc): "`dsh plugin --profile <name> <args...>` — profile
plugin management as a thin pnpm forwarder: initialize the profile on first use, run
`pnpm <args...>` in the profile directory, then reconcile the `dsh.profile.bundles` layer list
against the installed state."

`runPlugin(profile, args)` — `apps/cli/src/plugin.ts:116-152`:
1. `resolveProfileDir(profile)` → `$DSH_HOME/profiles/<name>`.
2. If no `package.json`: `initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)`
   (`:118-121`) and print `dsh: initialized profile <p> at <dir>`.
3. `spawnSync('pnpm', args.map(a => anchorPathSpec(a, process.cwd())), { cwd: dir, stdio: 'inherit', shell: win32 })` (`:127-131`).
4. On exit 0 → `reconcilePlugins(before, dir)` (`:139-140`); on `ENOENT` →
   `dsh: pnpm not found on PATH — install pnpm to manage profile plugins`, exit **127** (`:133-137`).
5. On non-zero: `dsh: pnpm failed in profile directory <dir>` and, if the args look git-hosted
   (`/^git\+|^github:|\.git(?:#|$)/`), the `allowBuilds` hint (`:141-150`).

`anchorPathSpec` — `:99-109`: rewrites a leading `.`/`..` (and its `file:`/`link:` forms) against
the **invoking** cwd, because pnpm's cwd is the profile dir. Documented at
`apps/cli/reference/README.md:43`.

`reconcilePlugins` — `:47-79`:
- a dependency that resolves to a manifest with `dsh.bundle.patch` (`exportsPatch` `:36-45`) and is
  not already in `bundles` → **pushed to the end of the list** (`:56-59`)
- a newly-added dependency without `dsh.bundle` → one-time warning
  `dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer
  (a later update that gains one activates it automatically)` (`:61-64`)
- a bundle no longer a bundle-less-or-absent dependency → **spliced out** (`:66-76`);
  template bundles (`dsh-base`, `dsh-web-app`) are not dependencies and are never touched (`:69-71`)
- only then `writeProfileManifest` (`:77-78`)

**Upgrade therefore needs no extra step**: `dsh plugin --profile <p> update <pkg>` is just `pnpm update`,
and the reconciliation is by *installed state*, not by dependency diff, "means `update` activates a
package that gained its `dsh.bundle` declaration in a newer version" (`:2-8`).

`initProfile` — `packages/boot/app-boot/src/profile.ts:152-166`: writes
`package.json` (`{ name: 'dsh-profile-<dir>', private: true, dependencies: {}, dsh: { profile: { bundles: [...] } } }`),
`cordis.patch.yml` from `PROFILE_PATCH_TEMPLATE` (`:127-131`, content `[]` plus comments), and
`pnpm-workspace.yaml` from `PROFILE_PNPM_WORKSPACE` (`:136-141`, `packages: [.]`,
`nodeLinker: hoisted`, `autoInstallPeers: false`). "Existing files are never touched, so re-running
is a no-op" (`:144-146`).
Templates: `PROFILE_TEMPLATES = { web: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'],
headless: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless'] }` — `:114-117`;
`DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']` — `:125`. A missing non-template profile
throws `dsh: profile "x" does not exist; create it with 'dsh plugin --profile x add <package>'`
(`:378-381`).

Resolution anchors (`apps/cli/reference/README.md:11`, `profile.ts:333-356`): in-box bundles resolve
from the **dsh installation first**, then the profile dir; a bare plugin `name` in any row resolves
through the profile dir's Node parent-walk, which reaches the maintained fallback
`$DSH_HOME/profiles/node_modules` (one symlink per installation-owned package, healed every launch —
`profile.ts:19-20,205`).

### 6.2 Uninstall: what happens to plugin data — **nothing**

`dsh plugin --profile <p> remove <pkg>` = `pnpm remove <pkg>` + the reconcile splice
(`apps/cli/src/plugin.ts:66-76`). It removes the `dependencies` entry and the `bundles` entry.
**It deletes no files the plugin wrote.** The `$DSH_HOME` subdirectory a plugin created (or its
`storages/<unit>.json` files, or its `sessions/` logs) survives removal untouched.

**No plugin-facing cleanup / uninstall hook exists.** Searched (all 0 relevant hits):
- `grep -rniE "uninstall|onUninstall|preUninstall|postUninstall|cleanup.*plugin" --include=*.ts apps/cli/src packages/boot` →
  only `installFailLoud`'s internal *uninstaller* closure (`packages/boot/app-boot/src/index.ts:646-648`)
  and a test of it (`:317-328`). Nothing plugin-facing.
- `grep -rn "dsh\.engines|engines" --include=*.ts packages/boot apps/cli/src` → **0 hits**, so the
  `dsh.engines.dsh: ">=0.1.1-rc.1"` key that some local plugins write
  (`dsh-session-readcache/package.json:29-33`, `dsh-free-search-chain/package.json`) is
  **never read by the host**. It is decoration. Do not rely on it, and do not expect a version gate.

The **only** lifecycle teardown a plugin gets is Cordis fiber disposal: every `ctx.effect`,
`ctx.on`, `tools.register`, `systemPrompt.section/context`, `settings.register`,
`webServer.register`, `storageDomain.open` disposer runs on unload
(`docs/user/develop/framework/index.md:41-62`), and process shutdown gives the tree **five seconds**
to dispose (`apps/cli/reference/README.md:79`; SIGINT→130 / SIGTERM→0, second signal forces exit).
Disposers start in reverse registration order but **async disposers run concurrently with no serial
completion guarantee** — put order-dependent cleanup in one `ctx.effect` and await serially there
(`docs/user/develop/framework/index.md:59-62`).

**Restart boundary:** "The successful pnpm operation changes the Profile manifest and Bundle list on
disk; a running Profile keeps the Bundle set from its current start. **Restart that Profile after
adding, removing, or updating a Bundle.**" — `apps/cli/reference/README.md:55`. Ordinary edits to
`cordis.patch.yml` *do* hot-reload (`:81`; `PROFILE_PATCH_FILENAME` is "hot-reloaded on long-lived
surfaces" — `profile.ts:38`) but "a live `cordis.patch.yml` edit re-evaluates expressions against
services that are still up, so it cannot reset a served port" (`:19`).

### 6.3 Boot failure modes you will actually hit

1. **`duplicate loader entry id: <id>`** — `vendor/loader/src/config/group.ts:64` (§1.5). Cause: your
   bundle patch inserts a row whose `id` another layer already used. The reference plugin warns about
   exactly this, `dsh-memory-evolve/cordis.patch.yml:5-7`: "do NOT insert this row again in the
   profile patch (duplicate ids crash the loader)."
2. **Host: `dsh: N entries did not activate`** — `packages/boot/app-boot/src/index.ts:723`,
   from `assertEntriesActivated` (`:697-727`). It names the reason per entry:
   `<name>: <stack>` for a FAILED fiber (`:709-715`),
   `<name>: pending (waiting for service(s): a, b)` for a PENDING fiber — with the missing services
   computed at `:716-719`. **This is the diagnostic for a typo in `inject`.**
3. **Host: `dsh: plugin(s) failed to load: <names>; Cordis startup failed because these plugin(s)
   could not be resolved`** — `assertEntriesLoaded`, `:657-662`. Cause: `main`/`exports` target
   missing (unbuilt `lib/`), or a bad `name:` specifier.
4. **Client: `web boot: N entr(y|ies) did not activate`** — `packages/client/web/src/boot.ts:156`,
   `assertEntriesActive` `:138-158`; same two arms (`import failed` `:142`, `pending (waiting for
   service…)` `:149-150`).
5. **Client: `client-modules: bundle <url> loaded without registering "<id>" via
   `__ModuleLoader__.load`** — `packages/client/modules/src/client/system.ts:120`. Cause: your
   browser bundle's banner id ≠ the loader entry `name` (= package.json `name`).
   `dsh-memory-evolve/scripts/build.mjs:36-49` documents this exact regression (its issue #3) and
   reads `PLUGIN_ID` from `package.json` rather than hard-coding it.
6. **Client: loud `404` on `GET /plugins/<id>/client.js`** — "a registered row whose bundle is
   unreadable because it has not been built yet" (`docs/subsystems/client-modules.md`, "The bundle
   route and index injection").
7. **`invalid plugin, expect function or object with an "apply" method, received <type>`** —
   `vendor/cordis/src/registry.ts:319`.
8. **A `Config` export that is a plain object crashes boot** — `resolveConfig` calls
   `runtime.Config['~standard'].validate(config)` whenever `Config` is truthy
   (`vendor/cordis/src/fiber.ts:50-62`). Confirmed empirically by a prior local plugin:
   `dsh-session-readcache.local-link.md:63-66` ("`Config` TIDAK diekspor … objek kosong `{}` meledak
   saat boot"). Either export a real Schemastery schema or export nothing.
9. **`dsh --profile <name> --dump-config`** inspects the composed tree **without booting**
   (`docs/user/develop/basic/publish.md`, `apps/cli/reference/README.md:32`) — the cheapest check
   that your layer landed. Layers are printed with a `# == <bundle-name>` header.

### 6.4 Local-plugin install recipe actually in use here

`dsh-session-readcache.local-link.md:57-66` documents the working local recipe and one rc.2 wart:
```bash
cd $DSH_HOME/profiles/web
pnpm add link:/abs/path/to/plugin
# rc.2 note from that doc: "dsh plugin add TIDAK menulis ulang daftar bundles" ->
# add the name manually to "dsh": { "profile": { "bundles": [...] } }
```
Verified against the live profile manifest
(`agent-workspace/.dsh/profiles/web/package.json:4-41`): ~24 `link:` entries plus `github:` and
registry deps, and `dsh.profile.bundles` includes them — so reconcile does work in the shipped
source (`apps/cli/src/plugin.ts:56-59`); the manual step in that note is worth re-checking on any
given run rather than assuming. A **disabled-but-installed** escape hatch also exists: add a
top-level `- id: <row-id>` + `disabled: true` to the profile patch
(`vendor/loader/src/config/entry.ts:18,96-104`) — no uninstall needed.

Confidence: verified-by-code, except §6.4's wart note which is a recorded field observation
(inferred-vs-code discrepancy, both cited).

---

## 7. External CLI / subprocess / direct LLM from a plugin

### 7.1 Subprocess — `ctx.subprocess` exists

Service `SubprocessRuntime`, abstract, `super(ctx, 'subprocess')` —
Context merge at `packages/subprocess/subprocess/src/index.ts:68-71`, class + `super` at `:102-104`.
Loaded implementation in the shipped composition: `@deepseek-ai/dsh-subprocess-local`
(`packages/bundle/base/cordis.patch.yml:163-164`).

Abstract API (`packages/subprocess/subprocess/src/index.ts:118-139`):
```ts
abstract resolveExecutable(command: string, env?: Readonly<Record<string,string>>, signal?: AbortSignal): Promise<string>
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```
Contract from the class doc (`:79-97`): `spawn` returns immediately with a live handle; `done`
resolves at process close and rejects only for spawn-level failures; offset-based non-consuming
collect-mode readers; `terminate()` is the **only** termination verb (SIGTERM→grace→SIGKILL,
tree-scoped on every platform); `waitForExit` observes whole-tree liveness; **service disposal
terminates all still-running managed processes and awaits their exit**;
`scrubbedParentEnv()` (`:61-67`) strips secrets and every `DSH_*`-prefixed key.
Consumers in-box: `subagent-codex/src/index.ts:31` and `subagent-claude-code/src/index.ts:31`
both `export const inject = ['subagents', 'subprocess']` — i.e. external-CLI dispatch is exactly
this seam.

**Not-found:** `grep -rn "class SubprocessRuntime" -A …` shows no `exec()` one-shot convenience;
`docs/subsystems/subprocess.md` owns the fuller narrative.

**Bypass precedent:** the reference plugin calls `node:child_process` `spawn`/`spawnSync` directly
(`dsh-memory-evolve/lib/index.js:20`), e.g. its `revealPath` ladder
(`lib/index.js:1770-1786`). That works but skips the managed-process guarantees above.

### 7.2 Long-running work — `ctx.jobs`

Service `JobRegistry`, abstract (`packages/jobs/jobs/src/index.ts:29-31` Context merge, class `:62`).
Loading the abstract seam directly throws
`@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as
@deepseek-ai/dsh-jobs-local instead` (`packages/jobs/jobs/src/index.ts:65-67`). Shipped: `@deepseek-ai/dsh-jobs-local`
(`packages/bundle/base/cordis.patch.yml:69-70`).
```ts
abstract start(spec: JobStart): JobId     // :82
abstract list(caller?: Agent): JobSnapshot[]   // :90
abstract get(id: JobId, caller?: Agent): JobSnapshot  // :99
abstract read(id: JobId, caller?: Agent): JobRead     // :109
abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'  // :120
```
Sanctioned tool-side recipe (`docs/cookbook/adding-a-tool.md` "Long-running work"):
"Gate `run_in_background` with producer config, then register through
`ctx.jobs.start({ kind, label, owner: exec.agent, run })`". Ids are `<kind>-N`.
"Once `ctx.jobs.start()` publishes the id, use a task-owned cancellation signal rather than
`exec.signal`". `start` refuses work when no attached job controller serves the owner (`packages/jobs/jobs/src/index.ts:36-45` doc, `:76-81`).

### 7.3 Calling the LLM directly — `ctx.llm.stream()`

Service `LlmRuntime` (`packages/llm/llm/src/index.ts:48-49`), `super(ctx, 'llm')` `:320`.
```ts
stream(options: GenerateOptions): AsyncIterable<StreamChunk>   // :174 (contract), :985 (runtime impl)
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle  // :365
listProviders(): LlmProviderInfo[]                             // :446
registerConfigurableProviders(entries): DirectoryRegistrationHandle  // :458
listConfigurableProviders(): LlmConfigurableProvider[]         // :517
registerModelDiscovery(...)                                    // :531
providerRetryPolicy(provider): ResolvedRetryPolicy             // :593
```
Verbatim real plugin call — `packages/session/session-title-llm/src/index.ts:252-273`:
```ts
const options: GenerateOptions = deepFreeze({
  provider: route.provider,
  model: route.model,
  messages,
  system,
  maxTokens: config.maxOutputTokens,
  sessionId: request.session.id,
  purpose: 'session-title',
  signal: callDeadline.signal,
})
const assembler = new BlockAssembler()
for await (const chunk of ctx.llm.stream(options)) {
  callDeadline.signal.throwIfAborted()
  assembler.push(chunk)
}
```
Message construction is explicit and **source-tagged**: `createUserMessage({ content: [{ type: 'text',
text: framedInput }], source: { kind: 'plugin', plugin: 'dsh-session-title-llm' } })` — `:246-249`.
Same idiom in `packages/compaction/compaction-basic/src/summarizer.ts:153-164`, which notes the call
"replay[s] … the conversation's own system [prefix]" for cache reuse
(`packages/compaction/compaction-basic/src/index.ts:228`). **Rule to follow:** pass `sessionId` and a
stable `purpose`, and reuse the assembled system prefix so you hit the provider KV cache.

Every provider HTTP request must go through an adapter: "with `ctx.llm.registerAdapter(providers,
adapter)`. Every provider HTTP request must include …" — `packages/llm/llm/src/index.ts:187`.
So a plugin that talks to a model **outside** `ctx.llm` (raw `fetch` to an API) is off the sanctioned
path and bypasses retry (`@deepseek-ai/dsh-llm-retry`, `base/cordis.patch.yml:72-73`), the token
meter, and telemetry.

### 7.4 Timers, schedules, `codeRuntime`

- **`ctx.timer`** exists **only client-side**: `packages/extensions/cordis-client-runner/src/client/timer.ts:18-20`
  (`interface Context extends Pick<ClientTimerService, 'interval'|'timeout'|'throttle'|'debounce'|'setTimeout'|'setInterval'>`).
  There is a vendored `@deepseek-ai/cordis-plugin-timer` (`vendor/timer/`), mounted host-side as row
  `timer` (`packages/bundle/base/cordis.patch.yml:16-17`), but `grep -rn "declare module
  '@deepseek-ai/cordis'" vendor/timer/src` → **no Context merge**, so it adds no typed `ctx.*` host face.
  Host-side background work should use `ctx.effect()` + your own disposer, or `ctx.jobs`.
- **`schedule`** — `packages/schedule/schedule/src/index.ts:33-35`: `export const name = 'schedule'`,
  `inject = ['agents','sessions','tools','sessionPersistence']`, and
  `grep -rn "provide(\|super(ctx," packages/schedule/schedule/src/index.ts` → **it provides no service**.
  So there is **no `ctx.schedule`**; scheduling is that plugin's own behavior, not a seam you inject.
- **`ctx.codeRuntime`** (`packages/code-runtime/code-runtime/src/index.ts:91`) is the Code Mode
  language host; `ctx.codeRuntime.language` keys the SDK renderer table
  (`packages/core/tools/src/index.ts:58-62`).

Confidence: verified-by-code (negatives from the cited greps).

---

## 8. Build toolchain for a local plugin package

### 8.1 What the in-box repo does (do NOT copy the mechanism, copy the artifact shape)

`docs/development.md:64-76` + root `package.json:20-25`:
```
"build":            "tsx scripts/build.ts"        # = build:lib then build:web
"build:lib:host":   "tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host"
"build:lib:client": "tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client"
"build:web":        "pnpm --filter @deepseek-ai/dsh-web-frontend run build"
```
Root `tsdown.config.ts:14-27`: `workspace: ['vendor/*', 'packages/*/*', 'apps/cli']`,
`entry: ''`, `outDir: 'lib'`, `format: ['esm']`, `platform: 'node'`, `target: 'es2024'`,
`fixedExtension: false`, `dts: false`, `clean: false`, and
`plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })]`.
Key ownership rule: "**Tsdown consumes only the JavaScript emitted to `lib/types` by the preceding
tsc phase**" (`docs/development.md:74`), and "**Typert runs only during Host tsdown**" (`:76`).
In-box packages define **no `build` script at all** — only 1 of 230 (`grep -l '"build"'
packages/*/*/package.json` → `packages/_custom/telegram-scraper`); they define `bundle`/`watch`
(`packages/client/ui-trajectory/package.json:43-44`) and rely on the root pass.
Package tsconfig rule (`packages/AGENTS.md:22`): extends `tsconfig.base.json` (client:
`tsconfig.base.client.json`), `rootDir: src`, `outDir: lib/types`, project-references every
workspace dep **plus** `runtime-diagnostics/invariants`, registered in exactly one aggregate.

### 8.2 What the local plugins here actually use — three working toolchains

| plugin | build | notes |
|---|---|---|
| `dsh-session-readcache` | **none** (`scripts: null`) | hand-written `lib/index.js` **committed**; `files: ["lib/index.js","cordis.patch.yml"]` |
| `dsh-memory-evolve` | `"build": "node scripts/build.mjs"` | **esbuild**, resolved from the DSH checkout (`scripts/build.mjs:20-22`, `DSH_SOURCE ?? ~/.dsh/source/current`), zero runtime deps, `lib/` committed (`.gitignore` does **not** list `lib/`) |
| `dsh-mnemon` | `"build": "tsdown && tsc -p tsconfig.types.json && node scripts/link-bundle-declarations.mjs"` | **tsdown** dual config (`tsdown.config.ts:82` exports `[host, client]`); `lib/` **is gitignored** (`.gitignore:3 /lib/`) |
| `dsh-ui-skin-switcher` | `"bundle": "tsdown", "watch": "tsdown --watch"` | mirrors the in-box shape (`files` includes `lib/types/**/*.d.ts`) |

### 8.3 The client (browser) bundle is not optional-toolchain — it has a fixed wire format

For any package with `dsh.client`, the built browser artifact must be a **CJS factory handed to
`window.__ModuleLoader__.load({ id, factory })`**. The in-box config
(`packages/client/tsdown.client.ts:544-565`):
```ts
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,          // a default clean would wipe the node-half output
    …
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
```
and the mirror from a working third-party config, `dsh-mnemon/tsdown.config.ts:37-60`:
```ts
  format: 'cjs', platform: 'browser', target: 'es2022', dts: false, clean: false,
  deps: { neverBundle: CLIENT_EXTERNALS, alwaysBundle: [/^dsh-mnemon-source-[^/]+\/presentation\//] },
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
```
`PLUGIN_ID` there is the **package name** (`tsdown.config.ts:14`), which must equal the loader entry
`name` — `dsh-memory-evolve/scripts/build.mjs:36-49` explains this at length and is the source of
failure mode §6.3(5).
Host entry naming: `clientBundle(id, …)` is called with the full package name —
`packages/client/ui-trajectory/tsdown.config.ts:3`:
```ts
export default clientBundle('@deepseek-ai/dsh-client-ui-trajectory', ['lib/types/index.js', 'lib/types/invariant.js'])
```

### 8.4 The `pnpm -r build` gotcha with a gitignored `lib/` — real, and here is the mechanism

Root `.gitignore:5` is `lib/`, and `dsh-mnemon/.gitignore:3` is `/lib/`. Consequences:
1. `exports` point at `./lib/*.js` (`packages/client/ui-trajectory/package.json:16-27`), so **with no
   build there is no module to import**: the loader entry gets no fiber → host
   `dsh: plugin(s) failed to load: …` (`packages/boot/app-boot/src/index.ts:657-662`), and the
   browser row 404s on `/plugins/<id>/client.js` (`docs/subsystems/client-modules.md`).
2. `pnpm -r build` recurses only over **workspace members**. The profile's own
   `pnpm-workspace.yaml` is `packages: [.]` (`agent-workspace/.dsh/profiles/web/pnpm-workspace.yaml:1-3`)
   — the profile is a workspace containing **only itself**, so a `link:`-installed plugin is *not* a
   member and `-r` never builds it. You must build inside the plugin checkout.
3. Inside a `dsh-custom/plugins/*` checkout, `pnpm -r build` **skips any package with no `build`
   script** — which is why `dsh-free-search-chain` and `dsh-session-readcache` define `scripts: null`
   and commit their `lib/`, while `dsh-mnemon/plugins/*` each define
   `"build": "tsdown"` (`plugins/dsh-mnemon-provider-byterover/package.json`) so `pnpm -r build`
   from the repo root reaches them (`dsh-mnemon/package.json` `verify` script chains
   `pnpm --workspace-concurrency=4 -r build`).
4. **A git install never runs `build` at all.** `docs/user/develop/basic/publish.md`
   ("Installing from GitHub: the build-script catch"): a git fetch ships *sources, not built
   artifacts*, so a TypeScript package arrives without `lib/` and fails to load. Fix, both sides:
   - author ships a self-contained **`prepare`** script (pnpm runs it after a git install) that
     transpiles `src/` with no project references and no type checking — `turtle-ui`'s dedicated
     tsdown config is the cited example;
   - user allowlists it in the **profile's** `pnpm-workspace.yaml`:
     ```yaml
     allowBuilds:
       dsh-hello-plugin: true
     ```
     (pnpm ≥10 blocks a git dep's `prepare` until allowed; `dsh` prints the pointer —
     `apps/cli/src/plugin.ts:143-150`). The root repo's equivalent stance is
     `pnpm-workspace.yaml:36-42`: "we deny by default and only allow scripts we need."
   Treat that allowance as "permission to execute the package's code on your machine at install
   time, outside any sandbox", pin a commit (`github:you/hello-plugin#<sha>`), or ship a built
   tarball via `pnpm pack` instead (`publish.md`, same section).

### 8.5 Files that must exist post-build (checklist)

For a host-only bundle plugin:
- `package.json` with `dsh.bundle.patch` → a real file, and that file listed in `files:`
- the patch YAML itself (row `name` = the package's own `name`)
- `main` / `exports["."]` target present and loadable as ESM (`"type": "module"`)

For a plugin with a browser half, additionally:
- `dsh.client` declared **and** `exports["./client"]` present — both, or
  `isDualFacePackage` is false (`packages/typert/generator/src/analyzer.ts:2629-2636`)
- `lib/client.js` exists, is CJS, is wrapped in the `__ModuleLoader__.load({ id: <pkg name> … })`
  banner/footer, and its id equals the loader entry `name`
- `lib/client.js` listed in `files:` (`packages/client/ui-trajectory/package.json:53-58`,
  `dsh-free-search-chain/package.json` `files: ["lib/index.js","lib/client.js","cordis.patch.yml"]`)
- every `@deepseek-ai/*` **value** import is either a module-table row, an inline-safe wire layer, or
  gone (§3.2) — otherwise the in-box purity gate fails the build; a third-party esbuild/tsdown build
  will *not* run that gate, so it becomes a runtime `require` throw instead

Verification commands that exist for this: `dsh --profile <p> --dump-config` (layers only, no boot),
then a real boot and reading for `did not activate` / `failed to load`.

Confidence: verified-by-code for §8.1–8.3 and §8.5; §8.4 items 2–3 are inferred from the observed
workspace files (`pnpm-workspace.yaml` contents + per-package `scripts`) plus the quoted doc, and
item 4 is documented behavior I did not execute.
