# Model routing

## Providers

- Primary gateway: Magpie at `http://magpie:3425/v1`.
- Direct providers may be registered through `pi-ai` for provider-native features or fallback.
- Credentials live only in runtime secrets or provider-managed auth files.
- Provider plugins publish only enabled models through `context.models.listModels()`. Descriptors
  include capability tags, input modalities (`text`, `image`, `audio`, ...), context/output limits,
  and optional reasoning levels/defaults.

## Capability policies

Plugins and agents declare capabilities:

```ts
type ModelCapability =
  | "chat.persona"
  | "chat.fast"
  | "summarize"
  | "memory.extract"
  | "coding"
  | "vision"
  | "tool-heavy"
  | "structured-output"
  | "plugin:<name>";
```

Each policy maps a capability to one or more models:

```ts
type ModelPolicy = {
  capability: ModelCapability;
  primary: ModelRef;
  fallbacks: ModelRef[];
  thinking?: "off" | "low" | "medium" | "high";
  maxOutputTokens?: number;
  budgetPerDayUsd?: number;
  allowedTools?: string[];
};
```

Examples:

| Capability       | Typical model class                         |
| ---------------- | ------------------------------------------- |
| `chat.persona`   | Strong conversational model                 |
| `chat.fast`      | Fast model for group chat or short requests |
| `memory.extract` | Cheap model run asynchronously              |
| `summarize`      | Cheap/medium model                          |
| `coding`         | Strong code model                           |
| `vision`         | Vision-capable model                        |
| plugin-specific  | Explicit model route declared by the plugin |

## Selection

1. Resolve explicit plugin/request override.
2. Resolve conversation persona/model binding.
3. Resolve capability policy.
4. Resolve global default.
5. Apply fallback, budget, and tool restrictions.

Selection is recorded per generation. Plugin A can request `plugin:a`; feature B can request `plugin:b`; neither needs to know the provider implementation.

## Conversation model and effort

Conversation policies may store an explicit `model` and `thinking` override. Runtime settings
store separate defaults:

- `chatModel` / `chatThinking` for WebUI chats and ordinary IM conversations.
- `workspaceModel` / `workspaceThinking` for workspace (coding) sessions.

Resolution order for one turn is:

1. The conversation policy's `model` / `thinking`, when set.
2. The matching chat or workspace runtime default.
3. The active provider port's default model and the provider's default reasoning effort.

The server syncs the resolved model and pi thinking level into the durable agent document
before each turn. A provider or runtime-default change re-syncs every conversation, while a
per-conversation override survives that change until it is cleared. Clearing an override
(`model: null`, `thinking: null`) deliberately returns the conversation to its surface default.

`workspace_spawn` accepts optional `model`, `modelProvider`, and `effort` arguments. Selection
is scoped to the active provider port (the provider defaults to it), and an unknown model is
rejected rather than silently starting a workspace on a different model. A workspace created
directly through the admin API accepts the same fields.

### Sidechat classifier

The sidechat classifier is not a routing policy; plugins advertise which of their models may run
it. A descriptor that carries `chat.sidechat` (`MODEL_CAPABILITIES.sidechat` in `@tsukaima/sdk`) is
eligible, so the provider decides that a model is fast or cheap enough instead of the host
assuming every chat model fits. `openai-compatible` exposes this as a per-model toggle, on by
default.

Resolution order:

1. `conversation.sidechat.model`, when set.
2. The runtime `sidechatModelId` setting, when set.
3. The active conversation model, even when the plugin does not tag it.
4. The first `chat.sidechat` model in catalog order, when no active model exists.

Model ids are only unique per provider, so a tie prefers the active provider. Completions run
through the plugin registry (`PluginHost.completeModel`), which means a classifier model may live
on a provider other than the one serving conversations; usage is recorded under `chat.sidechat`.
An unknown or unavailable configured model falls back to the active model, and a failed or
timed-out classification always means `wait`.

## Usage and limits

- Store token/cost usage per conversation, capability, plugin, and model.
- Rate-limit channel outputs and model calls separately.
- Expose usage in admin WebUI.
- Failed provider requests are durable failures, not lost turns.
