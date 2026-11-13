# Built-in plugin migration and remaining plugin gaps

This document records where every built-in capability currently lives, what has already moved
under `plugins/`, and what must still become a plugin. It is the working plan for the question
"move all built-in plugins under `plugins/`".

## 1. Current composition

The server has exactly one plugin composition root:

`apps/server/src/plugins/builtin.ts` imports `oneBotNapCatPlugin` and exports
`builtinPlugins`. `TsukaimaLifecycle` receives that list through `options.plugins` and hands it to
`PluginHost`.

That means the host seam already exists:

- `PluginHost` installs each manifest into `PluginRegistry`.
- It creates a permissioned `PluginContext`.
- It calls `setup(context)` and `teardown(context)`.
- It aggregates tools, settings, hooks, channel adapters, request persistence, and audit.

The remaining problem is not "there is no plugin system". It is that several capabilities never
became plugins and are still wired directly into `TsukaimaLifecycle`, `adminRouter`, or the WebUI.

## 2. What is already a plugin

| Plugin | Location | Owns |
| --- | --- | --- |
| `onebot-napcat` | `plugins/onebot-napcat` | OneBot protocol, WebSocket transport, normalization, channel registration, request resolution, plugin settings |

The OneBot protocol implementation was folded into
`plugins/onebot-napcat/src/protocol/` so it has exactly one consumer and no separate workspace
package. `packages/onebot` no longer exists.

## 3. What still looks like a built-in plugin but is not

### 3.1 `openai-compatible` model provider — moved

Current location after phase C:

- `plugins/openai-compatible`: manifest, config schema, provider factory, and `isConfigured()`.
- `packages/core/src/openai.ts`: the reusable OpenAI-compatible transport and model router; it is
  a library, not host wiring.
- `apps/server/src/lifecycle.ts`: resolves the configured provider from the plugin host and falls
  back to the fake model. It contains no provider credentials.

Remaining work:

- Move model discovery (`GET /models`) into a plugin RPC method and expose it through the plugin
  settings form. The host no longer has `settings.models`.
- Add per-model metadata (context window, cost, tool support) to plugin config instead of assuming
  one chat model.

### 3.2 `memory`

Current location:

- `apps/server/src/services/context-provider.ts`
- `packages/core/src/context.ts`
- `memories` table in `packages/db`
- retrieval tests in `apps/server/tests/context-provider.test.ts`

Current behavior: persona and memory are rendered as prompt sections for every model request.
Retrieval is keyword-based with importance and recency ranking.

Target:

- `plugins/memory`
- retrieval tool(s)
- extraction task(s)
- admin review API
- explicit scope enforcement

Memory injection currently runs unconditionally, so extraction into a plugin must not silently
change prompt behavior. The first step is to move retrieval/injection behind a host interface,
then let the plugin own policy and tools.

### 3.3 `persona`

Current location:

- `apps/server/src/services/context-provider.ts`
- `personas` and `persona_bindings` tables
- migration import path

Current behavior: the context provider reads the active persona binding and renders its prompt.

Target:

- `plugins/persona`
- versioned persona reads
- binding resolution
- admin API/UI
- optional persona tools

The persona prompt section is part of the model context contract. Moving it to a plugin must
preserve the exact section name and rendering order until a deliberate migration changes it.

### 3.4 `self-iteration`

Current location:

- `packages/coding`
- `coding_approvals` and `coding_proposals` tables
- no server registration or WebUI surface

Current behavior: the library is tested but not reachable from chat or the admin API.

Target:

- `plugins/self-iteration`
- tools for worktree creation, test/build/diff, proposal creation
- approval-card UI
- RPC namespace for proposals
- audit and task graph integration

This is the largest remaining plugin, but it should not move until the host has plugin RPC and
task surfaces.

### 3.5 `sticker-meme`

Current location:

- none in runtime
- design only in `docs/architecture/plugins.md`

Target:

- `plugins/sticker-meme`
- pack storage, tagging, semantic selection
- `channel.send` integration
- learned sticker candidates
- admin review for learned content

### 3.6 `search`

Current location:

- none in runtime
- model tools have no search provider

Target:

- `plugins/search`
- provider chain with keyless and keyed backends
- model-facing search/fetch tools
- result caching and source metadata

### 3.7 `proactive`

Current location:

- none in runtime

Target:

- `plugins/proactive`
- durable scheduled tasks
- idle/quiet-hours policy
- outbound campaign records
- admin controls and per-conversation opt-in

### 3.8 `chaos`

Current location:

- `packages/chaos`
- tests only

Target:

- `plugins/chaos` or keep as a test-only library
- dev-only manifest
- disabled by default

`chaos` is not a user-facing feature. It may stay a library unless the admin UI needs to run
failure drills. Do not ship it enabled.

### 3.9 `migration`

Current location:

- `packages/migration`
- `tools/migration`

Target: keep the CLI and library. Optionally add a first-party admin panel plugin later. The
migration kit must remain usable without the server.

### 3.10 `admin`

Current location:

- `apps/server/src/rpc/admin.ts`
- `apps/server/src/services/webui.ts`
- WebUI system routes

Target: this is host administration, not a bot plugin. Keep it in the server. Plugin management
screens may be contributed by plugins, but core admin authorization and audit stay in the host.

## 4. Required host surfaces before more plugins can move

| Surface | Needed by | Status |
| --- | --- | --- |
| `channels.register` | `onebot-napcat`, future Telegram | done |
| `settings.get/onChange` | all plugins | done |
| `requests.persist` | `onebot-napcat` | done |
| `audit.record` | all state-changing plugins | done |
| `tools.register/list/invoke` | memory, search, sticker, self-iteration | done |
| `events.on/emit` | all hook plugins | done |
| `ui.register/list` | all UI plugins | registry exists, WebUI not consuming |
| `models.registerProvider` | `openai-compatible` | done |
| `rpc.register` | self-iteration, memory review, plugin panels | done (host bridge; WebUI calls `admin/plugins/rpc`) |
| `tasks.create` | proactive, self-iteration | missing |
| `storage.conversation/global` | memory, sticker, plugins | bridge exists but host wiring is limited |
| plugin-owned migrations | any plugin with tables | missing |

## 5. Ordering

Recommended order, each step keeping `bun run check` green:

1. **Finish OneBot decoupling** — remove the last `onebot*` fields from settings/diagnostics
   contracts and make the WebUI read generic channel/plugin config. Done.
2. **Plugin UI registry consumption** — generic manifest metadata and JSON-schema config forms are
   rendered. Named panels/approval cards still need a host component registry.
3. **`models.registerProvider` + `plugins/openai-compatible`** — the second real built-in plugin.
4. **Plugin RPC registration** — needed before self-iteration and memory review can be plugins.
5. **`plugins/memory` and `plugins/persona`** — preserve prompt section names and behavior.
6. **`plugins/sticker-meme`, `plugins/search`, `plugins/proactive`** — new features with no
   existing runtime to preserve.
7. **`plugins/self-iteration`** — largest, depends on RPC, UI, approvals, and task surfaces.
8. **Optional `plugins/migration` panel** — never required for cutover.

## 6. Definition of done for "all built-ins under plugins/"

A capability counts as migrated only when:

1. Its implementation lives under `plugins/<name>/`.
2. It has `package.json` and `tsukaima.plugin.json`.
3. It exports `TsukaimaPlugin` and is listed in `apps/server/src/plugins/builtin.ts`.
4. It uses only `@tsukaima/sdk`, `@tsukaima/contracts`, and explicitly approved libraries.
5. It declares permissions, config schema, secret keys, hooks, tools, and UI contributions.
6. It has tests for setup, teardown, permissions, settings, and its main behavior.
7. The server has no direct import of its constants or internals outside the composition root.
8. The WebUI renders its configuration and UI through generic plugin surfaces.

The last point is the real measure. Moving files under `plugins/` while the server still imports
`ONEBOT_PLUGIN_ID` or hard-codes a settings form is not a completed migration.
