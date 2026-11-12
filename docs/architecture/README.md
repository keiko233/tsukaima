# Architecture

The system has five planes:

1. **Channel plane**: adapters normalize IM events into `MessageEnvelope`s and send outbound actions.
2. **Conversation plane**: `pi-durable` stores immutable entries, tasks, submissions, documents, usage, and compactions.
3. **Agent plane**: model routing, prompt assembly, tools, plugins, hooks, and policy.
4. **Domain plane**: users, relationships, memory, personas, stickers, moderation, and IM-specific state.
5. **Interface plane**: WebUI, admin APIs, migration tools, and deployment artifacts.

The bot host is a single Bun process for the first implementation. Plugin workers and coding jobs may run as separate Bun processes, but the conversation store remains the source of truth.

```text
NapCat / OneBot v11
        |
OneBot Channel (outbound WS)
        |
MessageEnvelope -> Activity Aggregator -> Conversation Router
        |
pi-durable conversation + tasks
        |
Agent Runner -> Model Router -> Magpie / direct providers
        |
Plugins, Memory, Persona, Stickers, Search, OneBot tools
        |
WebUI / Admin APIs
```

## Primary packages

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Bun | Main process, workers, scripts, and toolchain |
| Durable conversations/tasks | `@earendil-works/pi-durable` | SQLite storage; add Bun SQLite adapter |
| Model abstraction | `@earendil-works/pi-ai` | Register Magpie and direct providers |
| Coding capability | `@earendil-works/pi-coding-agent` | Reuse session/tools/resource concepts, do not expose it directly as a bot |
| MCP | Pi MCP extension or `@earendil-works/pi-mcp` | Optional external integrations |

`pi-durable` is currently marked experimental upstream. The design therefore isolates imports behind `packages/core`, keeps version upgrades behind conformance tests, and does not let plugins touch storage internals.
