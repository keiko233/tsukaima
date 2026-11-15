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

| Capability | Typical model class |
| --- | --- |
| `chat.persona` | Strong conversational model |
| `chat.fast` | Fast model for group chat or short requests |
| `memory.extract` | Cheap model run asynchronously |
| `summarize` | Cheap/medium model |
| `coding` | Strong code model |
| `vision` | Vision-capable model |
| plugin-specific | Explicit model route declared by the plugin |

## Selection

1. Resolve explicit plugin/request override.
2. Resolve conversation persona/model binding.
3. Resolve capability policy.
4. Resolve global default.
5. Apply fallback, budget, and tool restrictions.

Selection is recorded per generation. Plugin A can request `plugin:a`; feature B can request `plugin:b`; neither needs to know the provider implementation.

The busy-conversation sidechat classifier is not a capability policy: it uses
`conversation.sidechat.model` when set, otherwise the runtime `sidechatModelId`, otherwise the
active provider's default model. An unavailable configured model falls back to the active model,
and a failed or timed-out classification always means `wait`.

## Usage and limits

- Store token/cost usage per conversation, capability, plugin, and model.
- Rate-limit channel outputs and model calls separately.
- Expose usage in admin WebUI.
- Failed provider requests are durable failures, not lost turns.
