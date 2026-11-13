# Plugins

## Manifest

Every plugin has a typed manifest:

```ts
type PluginManifest = {
  name: string;
  version: string;
  apiVersion: string;
  kind: "builtin" | "first-party" | "third-party";
  permissions: PluginPermission[];
  tools?: ToolDefinition[];
  hooks?: HookDefinition[];
  tasks?: TaskDefinition[];
  ui?: PluginUiDefinition[];
  configSchema?: JsonSchema;
  secrets?: SecretRequirement[];
};
```

Manifests also declare two host-integration fields:

| Field | Purpose |
| --- | --- |
| `configEnv` | Config key -> environment variable name, used as a fallback when the stored value is empty |
| `secretKeys` | Config keys whose values are never returned by an API |

Plugin types:

- `tool`: registers callable tools.
- `pipeline`: subscribes to message lifecycle hooks.
- `automation`: schedules tasks or reacts to background events.
- `ui`: contributes WebUI panels or message cards.
- `channel`: provides adapters for new IM systems.
- `mixed`: combines the above.

## Runtime model

- First-party plugins may load in the main process after permission review.
- Third-party plugins run in a plugin worker by default.
- Workers communicate through typed RPC and event streams, not direct DB access.
- Tools and hooks are registered in a plugin registry resolved by the agent runner.
- Running work continues with the plugin version that started it; new work uses the newly loaded version where safe.

## Permissions

Required permission groups:

| Group | Example |
| --- | --- |
| conversation.read | Observe normalized message activities |
| conversation.write | Inject assistant/system messages or steer |
| channel.send | Send messages, stickers, files |
| channel.interact | Poke, react, recall, group management |
| memory.read/write | Access scoped memory |
| persona.read/write | Modify persona bindings |
| model.call | Call a declared model route |
| task.create | Create durable background tasks |
| ui.panel | Add WebUI panels |
| secrets.read.<name> | Read one named secret |
| coding.execute | Use self-iteration tools |
| deploy.propose | Create deployment proposals |

Permissions are declared, reviewed in admin UI, and audited. A plugin cannot silently expand permissions.

## Built-in plugins

Built-in plugins live in their own workspace packages under `plugins/*` and are loaded
through a single server composition root (`apps/server/src/plugins/builtin.ts`). They run in
the host process but go through the same registry, permission checks, settings store, and
`setup(context)` lifecycle as third-party plugins.

```text
plugins/onebot-napcat/
  package.json          @tsukaima-plugin/onebot-napcat
  tsukaima.plugin.json    declarative descriptor (kept in sync with the TS manifest by a test)
  src/manifest.ts       PluginManifest source of truth
  src/index.ts          export const plugin: TsukaimaPlugin
  src/*.test.ts
```

Implemented:

- `onebot-napcat`: outbound WS, envelope normalization, OneBot API facade, request
  resolution. Owns its channel registration, settings, and diagnostics. See
  [onebot.md](onebot.md).
- `openai-compatible`: OpenAI-compatible/Magpie model-provider factory. Owns its API key, base
  URL, and model id; the host only selects the provider id.

Planned first-party set:

- `memory`: scoped memory retrieval, extraction, and recall tools.
- `persona`: persona loading, versioning, and prompt sections.
- `model-router`: capability policies and usage reporting beyond the single chat policy the host
  currently seeds.
- `sticker-meme`: sticker packs, semantic tagging, auto-selection, and learning hooks.
- `search`: web/search abstraction with pluggable providers.
- `proactive`: scheduled, idle, and event-driven outbound campaigns.
- `qq-interactions`: grouped OneBot capabilities such as poke, reactions, member info, and group history.
- `admin`: session inspection, conversation reset, purge, plugin control.
- `self-iteration`: coding tasks, repository worktrees, tests, and deployment proposals.

Feature parity with DSH plugins is tracked in [docs/migration/dsh.md](../migration/dsh.md).

The concrete inventory, remaining host surfaces, and migration order are in
[builtin-plugin-migration.md](builtin-plugin-migration.md).
