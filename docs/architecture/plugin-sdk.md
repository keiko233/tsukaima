# Plugin SDK

The plugin SDK is the typed surface that Tsukaima exposes to first-party and third-party plugins. It is intentionally narrower than the internal runtime API.

Tsukaima does not adopt Cordis, Pi coding-agent extensions, or Chord wholesale as this plugin surface. It borrows lifecycle, validation, reload, worker, and UI-registry concepts. See `plugin-frameworks.md`.

## Goals

- Make common bot features declarative.
- Prevent plugins from bypassing policy, permissions, and audit.
- Make plugin state durable and inspectable.
- Allow UI contribution without direct database access.
- Keep the host resilient when a plugin crashes.

## Plugin lifecycle

1. Load manifest.
2. Validate manifest and config.
3. Resolve permissions.
4. Create the plugin context.
5. Call optional `prepare(context)` for host-surface registration that must exist before the
   conversation host is built (model providers, RPC).
6. Start in host or worker.
7. Call `setup(context)`.
8. Subscribe to hooks and register tools/UI/channels.
9. Run until disabled or replaced.
10. On disable/reload, call `teardown(context)`.

A plugin must not start background resources in module scope. Start them in `setup` and stop them in `teardown`.

## Runtime context

```ts
type PluginContext = {
  pluginId: string;
  manifest: PluginManifest;
  config: PluginConfig;
  logger: PluginLogger;
  storage: PluginStorage;
  events: PluginEvents;
  tools: PluginToolRegistry;
  ui: PluginUiRegistry;
  models: PluginModelRegistry;
  rpc: PluginRpcRegistry;
  channel?: PluginChannelApi;
  channels?: PluginChannelRegistry;
  settings?: PluginSettingsApi;
  requests?: PluginRequestApi;
  audit?: PluginAuditApi;
  dependencies?: PluginDependencyBag;
  memory?: PluginMemoryApi;
  persona?: PluginPersonaApi;
  tasks?: PluginTaskApi;
};
```

Each optional API is present only if the corresponding permission is granted.

Implemented host surfaces:

- `channels.register(adapter)` — a channel plugin owns a transport and registers it. The host
  wires inbound envelopes and requests into its own ingestion pipeline, so adapters never
  touch the durable store directly. See `ChannelAdapter` in `packages/sdk/src/host.ts`.
- `settings.get()` / `settings.onChange()` — per-plugin config, stored under
  `plugin-config:<pluginId>` in the domain `meta` table, with `manifest.configEnv` fallbacks.
  Writing a patch validates it against `manifest.configSchema` and notifies the plugin, which
  is how a channel restarts on a settings change.
- `requests.persist(request)` — durable friend/group request inbox.
- `audit.record(entry)` — host audit trail.
- `dependencies.get(key)` — host bindings injected for built-in plugins (for example a
  WebSocket transport factory). Third-party plugins never receive these.

Implemented: `models.registerProvider`, `rpc.register`, and generic plugin UI aggregation.
Not implemented yet: `memory`, `persona`, `tasks`.

`models.registerProvider()` accepts an id, an optional `isConfigured()` check, and a `createPort()`
factory. The host calls the factory after plugin preparation, so a model plugin can own its config
and credentials. A provider that is absent, unconfigured, or throws is replaced by the host's
deterministic fake model instead of failing startup.

`rpc.register(method, handler)` namespaces the method as `<pluginId>.<method>`. The authenticated
WebUI invokes it through `admin/plugins/rpc`; the host does not expose a generic arbitrary-function
bridge outside that audited procedure.

## Hooks

Plugins register hooks through typed names:

```ts
context.events.on("message.received", handler);
context.events.on("activity.opened", handler);
context.events.on("activity.closed", handler);
context.events.on("before.agent", handler);
context.events.on("before.reply", handler);
context.events.on("after.reply", handler);
context.events.on("task.created", handler);
context.events.on("task.completed", handler);
context.events.on("channel.connected", handler);
context.events.on("channel.disconnected", handler);
```

Hook handlers may:

- observe data
- add context
- modify safe fields
- request suppression
- schedule a task

They may not directly mutate durable history.

## Tools

Tools are declared in the manifest or registered dynamically.

```ts
context.tools.register({
  name: "my_plugin_lookup",
  description: "Look up plugin-specific data",
  parameters: z.object({
    query: z.string(),
  }),
  async execute(input, toolContext) {
    return {
      content: [{ type: "text", text: "..." }],
    };
  },
});
```

Tool rules:

1. Parameter and output schemas are validated.
2. Author-facing tool names are namespaced `<pluginId>.<tool>`, and `LocalToolBridge` rejects a
   name outside that namespace.
3. Tools declare required permission groups.
4. Tool execution is audited if it changes state.
5. Tools must return structured errors, not throw raw exceptions to the model.

The model never sees the dotted name. OpenAI-compatible providers only accept
`^[a-zA-Z0-9_-]{1,64}$`, so `createPluginToolsExtension()` publishes
`providerSafeToolName("<pluginId>.<tool>")` — the name sanitized and suffixed with a short
deterministic hash. The extension still invokes the original name, so routing, permission checks,
and audit records use the author-facing name.

All registered plugin tools are offered to the model by default; there is no per-tool allowlist,
`deferred` flag, or per-tool timeout yet.

## Storage

Plugins use scoped storage, not raw SQLite.

```ts
await context.storage.conversation.get(conversationId, "state");
await context.storage.conversation.set(conversationId, "state", value);
await context.storage.global.get("state");
await context.storage.global.set("state", value);
```

Storage values are versioned JSON. The host validates against the plugin's declared schema where available.

## Channel API

The channel API is permission-gated.

```ts
await context.channel?.send(conversationId, parts);
await context.channel?.sendPrivate(peerId, parts);
await context.channel?.sendGroup(groupId, parts);
await context.channel?.poke(conversationId, targetId);
await context.channel?.react(conversationId, messageId, reactionId);
await context.channel?.recall(conversationId, messageId);
await context.channel?.raw(action, params);
```

`raw` is available only with explicit permission and is audited. Credential APIs are not exposed.

## Memory API

```ts
await context.memory?.retrieve({
  query,
  scope,
  userId,
  conversationId,
  limit,
});

await context.memory?.propose({
  scope,
  subjectUserId,
  conversationId,
  content,
  summary,
  kind,
});
```

Plugin writes are proposals by default. They become memories only after host-side extraction or admin approval, depending on plugin trust.

## Persona API

```ts
context.persona?.current(conversationId);
context.persona?.instructions(conversationId);
```

Plugins generally do not mutate personas. A trusted plugin may propose a persona change, which is audited.

## Model API

```ts
const result = await context.model?.call({
  capability: "summarize",
  messages,
  tools,
  maxOutputTokens,
});
```

Plugins do not choose a provider directly. They request a capability.

## Task API

```ts
const taskId = await context.tasks?.create({
  kind: "my_plugin.refresh",
  input,
  schedule,
  background: true,
});
```

Tasks must be durable and resumable. Plugins should not use raw timers for work that must survive restarts.

## UI bridge

Plugins can contribute:

- side panel
- conversation action
- message card
- settings form
- approval card

UI declarations are data, not arbitrary JavaScript injected into the host page.

```ts
context.ui.register({
  kind: "panel",
  id: "my-plugin.review",
  title: "Review",
  component: "ReviewPanel",
  data: {
    procedure: "pluginUi.myPlugin.getReview",
  },
});
```

The WebUI renders the component using its own beUI implementation and calls the plugin's exposed oRPC namespace.

Current host rendering is deliberately generic: the plugin page shows manifest metadata and
declared UI entries, and the settings page renders a JSON-schema-driven config form for every
plugin with a `configSchema`. The WebUI does not import plugin React components, so a plugin cannot
execute arbitrary page code. Richer named components can be added later by extending the host's
component registry rather than by loading remote modules.

The plugin UI design is now specified in [plugin-ui.md](plugin-ui.md). It adds a two-pane
`/plugins` route, trusted build-time React panels for built-in/first-party plugins, a shared
`@tsukaima/sdk/ui` kit, a status snapshot channel, and `@tsukaima/sdk/i18n` for Paraglide-compiled
plugin messages. Third-party plugins that ship a panel in the workspace bundle are gated behind
a confirmation modal; runtime-installed plugins remain data-only until a sandboxed panel tier
exists.

## Worker boundary

Third-party plugins run in a worker by default.

Allowed across boundary:

- typed RPC calls
- serialized events
- streamed task progress
- UI declarations

Not allowed across boundary:

- direct SQLite access
- direct file access outside plugin data
- raw secrets
- direct durable conversation mutation

The worker crashes independently. The host restarts the worker and reports the failure to the WebUI.

The worker protocol is Tsukaima-specific. It is intentionally not Cordis Context wire-compatible and not Chord-link-compatible.

## Plugin package format

```text
my-tsukaima-plugin/
  package.json
  tsukaima.plugin.json
  dist/index.js
  README.md
```

`tsukaima.plugin.json`:

```json
{
  "name": "my-tsukaima-plugin",
  "version": "0.1.0",
  "apiVersion": "1",
  "kind": "third-party",
  "permissions": [
    "conversation.read",
    "channel.send",
    "memory.read"
  ],
  "tools": ["dist/tools.js"],
  "hooks": ["dist/hooks.js"],
  "ui": ["dist/ui.js"],
  "configSchema": "./config.schema.json"
}
```

The exact loader format is finalized during implementation.

DSH plugins are migration sources for behavior/configuration, not installable packages. A DSH plugin is reimplemented against this SDK after API review.

## Security rules

1. Deny by default.
2. Require explicit grant for destructive or outbound actions.
3. Audit every permission change and state-changing tool call.
4. Never pass secrets to a plugin unless it declares `secrets.read.<name>` and the admin grants it.
5. Validate every cross-boundary payload.
6. Timeout plugin calls.
7. Never allow plugin UI to execute arbitrary host code.

## Testing requirements

Every plugin should ship:

1. Manifest validation tests.
2. Tool input/output tests.
3. Hook behavior tests with fake conversations.
4. Permission denial tests.
5. Storage serialization tests.
6. Restart recovery tests if it uses tasks.

Built-in plugins follow the same rules, even if they run in the host process.
