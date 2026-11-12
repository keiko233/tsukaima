# Plugin decoupling plan

This document answers one question: **how do we move the OneBot integration (and the
other things currently hard-wired into the server) out of the process core and into
built-in plugins living under a `plugins/*` workspace?**

It is a plan, not a decision record. Once the host seam is agreed on, the parts that
change the runtime contract should be captured as an ADR.

## 1. Why the current shape is wrong

The plugin framework was built first (`packages/sdk`, `packages/plugin-registry`) but was
**never wired into the server**. `apps/server/src` contains zero plugin references:

```sh
rg -n "plugin" apps/server/src   # only the `plugins` DB table read in rpc/admin.ts
```

So the plugin SDK is currently libraries-only. Because there was no host seam to plug a
channel into, the OneBot channel was constructed inline in the lifecycle. The result is a
god object:

| File | Lines | Responsibility |
| --- | --- | --- |
| `apps/server/src/lifecycle.ts` | 787 | config, settings, logging, DB open/migrate, model provider choice, conversation host, OneBot channel lifecycle, envelope ingestion, user/chat/session resolution, request persistence, request resolution, audit, shutdown |

Concretely, OneBot-specific code is spread across the process core:

| Leakage point | Location |
| --- | --- |
| channel construction + restart | `lifecycle.ts:244` `replaceOneBotChannel` |
| channel settings resolution | `lifecycle.ts:234` `resolveOneBotSettings` |
| restart-required flag | `lifecycle.ts:73`, `:284`, `:116` |
| diagnostics getters | `lifecycle.ts:457` `onebotDiagnostics`, `:461` `onebotConfigured` |
| external envelope ingestion | `lifecycle.ts:291` `processEnvelope` |
| request persistence | `lifecycle.ts:408` `processRequest` |
| friend/group request approve/reject | `lifecycle.ts:465` `resolveChannelRequest` |
| identity upsert hard-coded to `onebot-v11` | `lifecycle.ts:586` `ensureSender` |
| outbound send path | `services/webui.ts:482` reads `lifecycle.onebotChannel` |
| diagnostics RPC hard-coded to a single channel | `rpc/admin.ts:91-116` |
| runtime settings fields | `runtime-settings.ts` (`onebotWsUrl`, `onebotAccessToken`) |
| env config fields | `config.ts:7-8`, `:23-24` (`TSUKAIMA_ONEBOT_*`) |

The domain layer is *almost* channel-generic already (`chat_objects.channelId`,
`conversations.channelId`, `envelope.channelKind`, `envelope.channelId` all exist), but the
wiring above assumes exactly one channel with one set of settings, one env prefix, and one
set of RPC fields.

### What is already correctly decoupled

- `packages/onebot` is a standalone, tested protocol package (normalization, transport,
  reconnect, action facade). It only needs to stop being *constructed* by the lifecycle.
- `packages/core`, `packages/db`, `packages/durable`, `packages/contracts` are domain and
  infrastructure libraries, not plugins. They stay.
- `packages/coding`, `packages/migration`, `packages/chaos` are feature libraries that were
  never registered as plugins either.

So the refactor is mostly about **introducing host seams**, not rewriting protocol code.

## 2. Root cause: there is no host surface for plugins

`PluginContext` (`packages/sdk/src/types.ts`) exposes exactly: `config`, `logger`,
`storage`, `conversation.read`, `events`, `tools`, `ui`, and an optional `channel.send`.

A plugin therefore cannot:

1. **own a channel** — there is no way to register an adapter or receive inbound events;
2. **own a model provider** — providers are chosen inside the lifecycle;
3. **contribute RPC/procedures** — the WebUI bridge can only declare `component` names,
   with no host namespace behind them;
4. **own database tables or migrations** — `packages/db` holds one central Drizzle schema;
5. **persist real settings** — runtime settings are a fixed struct, not per-plugin config.

Point 1 is exactly why OneBot could not be a plugin. Fix the surface and the decoupling
mostly falls out.

## 3. Target shape

### 3.1 Workspace layout

```text
apps/
  server/            # host only: boot, lifecycle, RPC mounting, WebUI serving
  web/               # renders plugin UI declarations; no plugin code
packages/            # libraries, never imported by plugins except sdk/contracts/db
  sdk/               # plugin-facing API (grows a host-surface section)
  plugin-registry/   # manifest validation + install state
  contracts/ core/ db/ durable/
plugins/             # built-in plugins, each its own workspace package
  onebot-napcat/
  openai-compatible/
  memory/
  persona/
  sticker-meme/
  search/
  proactive/
  self-iteration/
  chaos/             # dev-only, disabled by default
tools/               # CLIs (migration runner stays here)
```

Root `package.json` adds `"plugins/*"` to `workspaces`; `tsconfig.json` adds
`"plugins/**/*.ts"` to `include`; the `format`/`format:check` scripts add
`'plugins/**/*.ts'`.

### 3.2 Layering rule (the important part)

```text
plugins/*  ->  @tsukaima/sdk, @tsukaima/contracts, @tsukaima/db (read-only via host repos)
plugins/*  -/- apps/server        (never)
apps/server -> @tsukaima/plugin-registry + one composition root file that imports
               the built-in plugin packages and nothing else
```

The composition root is a single file, e.g. `apps/server/src/plugins/builtin.ts`, that
lists `[@tsukaima-plugin/onebot-napcat, ...]`. That keeps the app depending on one place
instead of scattering plugin imports, and gives a single toggle point for tests.

### 3.3 Host services (`TsukaimaHost`)

Extract the responsibilities currently trapped in `TsukaimaLifecycle` into named services
that a plugin receives through `context`:

| Service | Extracted from | Plugin-facing verbs |
| --- | --- | --- |
| `ChannelRegistry` | `replaceOneBotChannel`, `onebot*` getters | `register(adapter)`, `list()`, `send(channelId, envelope)`, `get(channelId)` |
| `ConversationRouter` | `processEnvelope` (the non-OneBot parts), `resolveChatSession` | `ingest(envelope) -> { sessionId, chatObjectId }`, `resolveIdentity(sender)` |
| `RequestService` | `processRequest`, `resolveChannelRequest` | `persist(request)`, `respond(requestId, action)` (routes through the registry) |
| `ModelRegistry` | `createModelPort` | `registerProvider({ id, models, createPort })`, `portFor(capability)` |
| `SettingsStore` | `runtime-settings.ts` | `get(pluginId)`, `set(pluginId, patch)`, `subscribe(pluginId, cb)` |
| `AuditService` | `writeAudit` | `record(entry)` |
| `HookBus` | new | `emit(name, payload)` at real pipeline points |

The lifecycle keeps only: config, logging, DB open/migrate, plugin loading, HTTP binding,
and shutdown ordering. It should shrink from ~790 to roughly 250 lines.

### 3.4 Manifest + package format

Built-in plugins follow the documented format (`docs/architecture/plugin-sdk.md`):

```text
plugins/onebot-napcat/
  package.json          @tsukaima-plugin/onebot-napcat
  tsukaima.plugin.json    name, version, apiVersion, kind: "builtin", permissions, configSchema
  src/index.ts          export const plugin: TsukaimaPlugin = { manifest, setup, teardown }
  src/*.test.ts
```

`kind: "builtin"` plugins run in the host process (`runMode: "host"`), but go through the
exact same registry, permission checks, and `setup(context)` lifecycle as third-party ones.

## 4. Host surface to add to the SDK

`PluginContext` grows (all permission-gated):

```ts
type PluginContext = {
  // existing: config, logger, storage, conversation, events, tools, ui
  channels?: {
    register(adapter: ChannelAdapter): Disposable;
    get(channelId: string): ChannelAdapter | undefined;
    list(): readonly ChannelHandle[];
  };
  models?: {
    registerProvider(provider: ModelProviderContribution): Disposable;
  };
  rpc?: {
    register(namespace: string, router: Router): Disposable; // mounted as pluginUi.<namespace>
  };
  settings?: {
    get<T>(): Promise<T>;
    onChange(handler: (next: T) => Promise<void> | void): Disposable;
  };
  requests?: {
    persist(request: ChannelRequest): Promise<void>;
  };
  audit?: { record(entry: AuditEntry): Promise<void> };
};
```

`ChannelAdapter` is the generalization of what `OneBotChannel` already does:

```ts
type ChannelAdapter = {
  id: string;                  // "onebot-napcat"
  kind: string;                // "onebot-v11" (written into chat_objects.channelId)
  start(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): ChannelDiagnostics;
  send(conversation: OutboundTarget, parts: readonly MessagePart[]): Promise<SendResult>;
  onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
  onRequest?(handler: (request: ChannelRequest) => void): void;
  capabilities(): readonly ChannelCapability[]; // send, interact, group-manage, raw...
};
```

Hook emission points must be wired to real code. Today `manifest.hooks` validates names but
nothing ever fires them. Minimum set for the OneBot extraction:
`channel.connected`, `channel.disconnected`, `message.received`, `activity.opened`,
`activity.closed`.

## 5. Plugin inventory

Ordered by how much is in the core today (most entangled first).

| Plugin | Current home | Moves out of the core | Needs from host | Phase |
| --- | --- | --- | --- | --- |
| `onebot-napcat` | `lifecycle.ts` + `packages/onebot` (lib) | channel lifecycle, settings, diagnostics, envelope/request ingestion, request resolution, outbound send | `channels`, `conversation.ingest`, `requests`, `settings`, `audit`, `hooks` | A/B |
| `openai-compatible` | `lifecycle.createModelPort`, `remote-models.ts`, `config.openAi*`, `runtime-settings.openAi*` | provider construction, model listing, usage recording | `models.registerProvider`, `settings` | C |
| `self-iteration` | `packages/coding` (lib) | runner, worktree policy, proposal store, reload controller → add tools + RPC + UI panel | `tools`, `rpc`, `audit`, `tasks` | D |
| `memory` | not implemented (`docs/architecture/memory.md`) | scoped storage, retrieval, extraction, recall tool | `memory` API + table ownership | D |
| `persona` | migration-only | persona load/version/prompt sections | `persona` API | D |
| `sticker-meme` | not implemented | sticker packs, tagging, auto-selection | `channel.send`, storage | D |
| `search` | not implemented | search abstraction + providers | `model`/`http` capability | D |
| `proactive` | not implemented | scheduled/idle outbound | `tasks`, `channel.send` | D |
| `chaos` | `packages/chaos` (lib) | failure injection drills | `storage` wrapper | D (dev-only) |
| `migration` | `packages/migration` + `tools/migration` | stays a CLI/library; optionally a first-party admin panel | `rpc`, `ui` | optional |

`qq-interactions` from `docs/architecture/plugins.md` can start life inside
`onebot-napcat` (it is the OneBot action facade) rather than as a separate package.

## 6. Open decisions

1. **Plugin DB migrations.** `packages/db` has one central Drizzle schema and one migration
   journal. A true drop-in plugin must not require editing a central schema. Recommended:
   each plugin owns `migrations/*.sql` + a Drizzle config; the host runs a
   `MigrationRegistry` that applies every enabled plugin's journal at boot, after core
   migrations and before plugin `setup()`. Needs its own ADR — it changes the migration
   contract in `docs/architecture/startup-lifecycle.md` §4.
2. **Settings + env mapping.** Replace the fixed `RuntimeSettings` struct with per-plugin
   config validated against `manifest.configSchema`, plus a tiny host-level set
   (`logLevel`). Keep `TSUKAIMA_ONEBOT_*` as a deprecated fallback that maps to
   `onebot-napcat` config for one release.
3. **RPC contribution shape.** Decide whether plugins register oRPC routers directly
   (recommended, mounted under `pluginUi.<namespace>`) or only declare procedure names that
   the host implements.
4. **`apiVersion` policy.** Define when `"1"` bumps and whether a built-in plugin can be
   skew-mismatched against the SDK at boot.
5. **Reload semantics.** Reuse the existing `replaceOneBotChannel` stop/start behavior as
   the reference implementation for hot-reloading a channel plugin.
6. **Worker vs host for built-ins.** Keep `host` for built-ins first; revisit only if a
   built-in is untrusted.

## 7. Phased plan

Each phase should keep `bun run check` green and add tests rather than only moving code.

Status: **Phase A and Phase B are implemented.** Phases C–E remain.

### Phase A — Host seam, no behavior change (done)

1. Add `ChannelRegistry`, `ConversationRouter`, `RequestService`, `ModelRegistry`,
   `SettingsStore`, `AuditService`, `HookBus` to `apps/server/src/services/`.
2. Wrap the existing `OneBotChannel` in a `ChannelAdapter` and register it — still
   constructed by the lifecycle, just via the registry.
3. Rewire `rpc/admin.ts` diagnostics and `services/webui.ts` sends to go through the
   registry, so no caller reads `lifecycle.onebotChannel`.
4. Emit the initial hook set at the real pipeline points.
5. Acceptance: existing tests pass unchanged; diagnostics output identical; add a
   multi-channel registry test proving a second fake adapter routes independently.

### Phase B — Extract `plugins/onebot-napcat` (done)

1. Create the workspace package; `setup()` builds `OneBotChannel` from its own settings and
   registers itself; `teardown()` stops it.
2. Move `resolveOneBotSettings`, `replaceOneBotChannel`, `processRequest`,
   `resolveChannelRequest`, and the OneBot-specific identity mapping into the plugin;
   ingestion calls `context.conversation.ingest(envelope)`.
3. Delete `onebot*` members from `TsukaimaLifecycle`, `config.ts`, `runtime-settings.ts`,
   `rpc/admin.ts`, `services/webui.ts`.
4. Acceptance: the server boots with `plugins/onebot-napcat` disabled and OneBot simply
   absent (no crash, no dead fields); a live WS test drives ingest through the plugin.

Phase B shipped with these deviations from the sketch above:

- The adapter keeps the channel id `onebot` (not `onebot-napcat`) because envelopes and
  `chat_objects.channelId` are already written that way. The plugin package name and the
  channel instance id are intentionally different.
- `ChannelRegistry.register` wires the host ingestion pipeline, so plugins never call
  `conversation.ingest` themselves — adapters only deliver envelopes.
- Plugin settings live in the `meta` table under `plugin-config:<pluginId>` and resolve
  `manifest.configEnv` fallbacks. The `admin/settings` onebot fields remain as a legacy wire
  alias that the RPC layer maps onto the plugin config, so the WebUI did not change.
- `plugins.rpc.register` and `plugins.models.registerProvider` were **not** added yet; no
  implemented plugin needs them. They belong to Phases C–D.

### Phase C — Extract `plugins/openai-compatible`

1. Move `createModelPort` + `remote-models.ts` into a model-provider plugin.
2. Add the models section to the WebUI settings as a plugin `settings-form`.
3. Acceptance: with the plugin disabled, the server falls back to the fake model.

### Phase D — Register the remaining feature libraries

1. Register `coding` as `self-iteration` (tools + RPC + panel).
2. Build `memory`, `persona`, `sticker-meme`, `search`, `proactive` as plugins with the
   plugin-owned migration path from §6.1.
3. Move `chaos` behind a dev-only manifest.

### Phase E — Cleanup

1. Delete the fixed runtime-settings struct and the `plugins` table shim once the loader
   persists real registry state.
2. Update `docs/architecture/plugins.md`, `plugin-sdk.md`, `startup-lifecycle.md`, and
   `project-state.md` to describe the shipped surface.

## 8. Risks

- **Single-writer SQLite vs plugin migrations** — plugin migration runners must be
  serialized under the same startup lock as core migrations.
- **Hidden coupling in `ensureSender`** — identity keys currently hard-code
  `platform: "onebot-v11"`; the extracted router must take the platform from the adapter's
  `kind`, or existing rows break.
- **Settings/env churn** — the env fallback must keep working across one release so the
  current deployment does not need an atomic cutover.
- **Scope creep** — Phase B is the actual ask; Phases C–E should not start until the seam
  from Phase A is reviewed.
