# Plugin host maturity spec

## Outcome

All first-party bot features can be delivered as plugins without central-schema, lifecycle, UI,
or task hacks.

## Current boundary

The plugin SDK has manifests, permissions, worker isolation, tools, hooks, RPC/UI/model
bridges, settings/status, install/uninstall, audit, requests, durable tasks, and plugin-owned
databases. Missing production surfaces:

- durable task creation
- per-tool allowlist/deferred/timeout
- named UI component registry
- marketplace/install updates
- policy-controlled external effects

## Plugin-owned migrations and storage

Each plugin gets its own `data/plugins/<sanitized-id>.sqlite` file. Plugins declare only a
migrations directory in the manifest; the host loads `<version>_<name>.sql` and optional
`<version>_<name>.down.sql` files from the plugin root. A `MigrationRegistry`:

1. runs after core migrations, before plugin `prepare()`
2. applies enabled plugin journals inside that plugin's database
3. serializes with the core migration lock
4. records version, checksum, applied at, timing in `_elaina_plugin_migrations` inside the
   plugin database
5. rejects duplicate/reordered versions and checksum drift
6. supports dry-run and rollback
7. moves legacy `plugin_<id>_*` tables out of `domain.sqlite` on first startup, then drops them

Core tables remain host-owned and never appear in a plugin database. The plugin SQL facade rejects
`ATTACH`/`DETACH` and `VACUUM INTO`, so a plugin cannot escape its own file even with raw SQL.
Plugins that own relational tables run in `host` mode with the database handle; `worker`-mode
plugins access persisted state exclusively through host-mediated `PluginStorage` / RPC calls
across the `BunPluginWorker` boundary. Durable `PluginStorage` remains the right home for small
key-value state that does not need relational queries.

## Task surface

Add `tasks.create`, `tasks.get`, `tasks.list`, `tasks.cancel`, and `tasks.watch` behind
permission. Every task has:

- plugin ID, conversation/chat ID, kind
- payload, dedupe key
- status, attempts, max attempts, next run
- durable log/outcome
- permissions inherited or narrowed

Use the host scheduler for delays/repeats; do not duplicate timers in plugins. Also wire host
emission points for `task.created` and `task.completed` hooks.

## Outbound reply transform hook

Add an ordered, permission-gated outbound transform hook (`reply.transform` or an extensible
`before.reply` transform result) between model answer completion and `ReplyDispatcher` send, so
plugins such as `sticker-meme` can replace validated directives with `MessagePart[]` without core
server code importing plugin internals.

## Tool naming, permissions, and policy

Preserve `LocalToolBridge`'s `<pluginId>.<action>` namespacing rule: every plugin tool registers
as `<pluginId>.<action>` and continues mapping to providers via `providerSafeToolName()`.
Update `pluginPermissionSchema` in `packages/sdk/src/manifest.ts` to validate new host scopes
(`tasks.*`, `ui.approval-card`, `coding.*`, `storage.global`, `conversation.read`, and `*` if
retained) consistent with `packages/sdk/src/permissions.ts`.

Tool registrations add:

```ts
type ToolPolicy = {
  visibility: "model" | "ui" | "admin" | "hidden";
  deferred?: boolean;
  timeoutMs: number;
  maxConcurrent: number;
  requiredConversationCapabilities?: string[];
  conversationAllowlist?: boolean;
  destructive?: boolean;
  maxPayloadBytes?: number;
};
```

Policy resolution:

1. plugin manifest permission
2. global/plugin tool allowlist
3. conversation policy
4. user/admin role
5. task kind

Unknown/unauthorized tools become explicit model-visible errors. UI/admin tools are not exposed
to the model unless policy allows. Timeout/cancellation releases resources and writes audit.

## UI component registry

Clarify the two-tier UI contract alongside `docs/architecture/plugin-ui.md` and `definePluginUi()`:

- **Trusted plugin admin pages** (built-in and first-party `src/ui.tsx` panels) remain build-time
  React panels using `@elaina/sdk/ui`.
- **Declarative component registry** supports named embeddable slots and third-party fallback UI:
  `approval-card`, `memory-review`, `sticker-grid`, `task-list`, `task-graph`, `diagnostic-card`,
  and `settings-form`.

Each declaration carries schema/data contract, permissions, i18n keys, and compatible host
version. Unknown component falls back to generic card. Plugins may contribute panels/actions.

## Channel and model capabilities

Extend `ChannelAdapter.capabilities()` with machine-readable capabilities:

`send.text`, `send.image`, `send.audio`, `send.video`, `send.file`, `send.forward`,
`reply.quote`, `interact.poke`, `interact.react`, `interact.typing`, `manage.group`,
`manage.friend`, `manage.self`, `read.history`, `fetch.media`.

Provide a compatibility mapping from legacy `ChannelCapability` values (`send`, `interact`,
`group-manage`, `read-info`, `read-media`, `upload`, `raw`) and migrate `onebot-napcat` to the
granular capabilities. Plugins requesting actions must check registry capability; host can narrow
by conversation.

Extend `PluginModelProvider` / model routing interfaces with optional `embedding` and
`audio.transcribe` (STT) capability ports (in addition to chat `Models`) so Phase 1 voice
transcription and Phase 4 vector retrieval do not bypass plugin model configuration.

## Install lifecycle

- builtin/first-party/third-party kinds preserved
- manifest compatibility check
- install/upgrade/downgrade with migration plan
- backup plugin config and data before destructive upgrade
- quarantine on repeated setup failure
- health/status/reload
- uninstall policy and optional data retention

Marketplace is separate; local/admin-managed first.

## Worker contract

1. structured bootstrap and version handshake
2. cancellable RPC calls
3. streaming tool progress/logs
4. crash detection and restart policy
5. no direct host DB access; only approved storage repos
6. request timeouts and backpressure

## Tests

1. Core/plugin migration ordering and checksum.
2. Task create/claim/cancel/restart.
3. Tool policy timeout/concurrency/visibility.
4. Component fallback and permission.
5. Channel capability narrowing.
6. Install/upgrade/downgrade failure recovery.
7. Worker crash/timeout.

## Acceptance

Memory/persona/sticker/search/proactive/self-iteration can be true plugins, and the server does
not import their internals.
