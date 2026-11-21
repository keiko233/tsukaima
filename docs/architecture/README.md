# Architecture

This document set is the durable design record for Tsukaima. Each file is meant to survive across multiple working sessions without needing the original conversation.

## Document map

| Document | Purpose |
| --- | --- |
| [Project state](../project-state.md) | Current phase, completed work, next actions, and context needed to resume |
| [Runtime and persistence](runtime.md) | Process model, `pi-durable`, SQLite adapter, storage boundaries, media, failure behavior |
| [KV cache](kv-cache.md) | Keyv-backed TTL cache, live-run streaming, reconnect snapshots, plugin cache |
| [Startup lifecycle](startup-lifecycle.md) | Boot stages, database migrations, service readiness, and shutdown |
| [Runtime logging](logging.md) | Structured tracing records, console/SSE transports, retention, and WebUI rendering |
| [Domain model](domain-model.md) | Envelopes, activity windows, conversation resolution, users, memory, persona |
| [Database design](database.md) | Exact domain tables, durable boundaries, indexes, migrations, and query rules |
| [API design](api.md) | oRPC namespaces, procedures, context, errors, realtime patterns, and WebUI flows |
| [Conversation flow](conversation-flow.md) | End-to-end message pipeline, aggregation, policy, model turn, tool execution, and output |
| [Workspace and prompt hooks](workspace-and-hooks.md) | Chat/workspace execution split, shared queueing, durable prompt hooks, and graceful updates |
| [OneBot/NapCat integration](onebot.md) | Event normalization, action facade, reconnect, permissions, and operational edge cases |
| [Plugins](plugins.md) | Manifest, permissions, worker runtime, lifecycle, and built-in plugin requirements |
| [Plugin SDK](plugin-sdk.md) | Runtime API, context, RPC boundary, UI bridge, and testing expectations |
| [Plugin UI, status, and i18n](plugin-ui.md) | Two-pane plugin page, trusted React panels, shared UI kit, status reporting, and plugin translations |
| [Plugin framework comparison](plugin-frameworks.md) | Cordis, Pi extensions, Chord, and the chosen Tsukaima plugin design |
| [Plugin decoupling plan](plugin-decoupling.md) | Host seam, `plugins/*` workspace, and the phase plan for moving core features into plugins |
| [Memory](memory.md) | Scopes, schema, retrieval pipeline, extraction policy, and admin review |
| [Model routing](model-routing.md) | Capability policies, provider registration, selection order, and usage accounting |
| [WebUI](web-ui.md) | Admin console layout and interaction model |
| [Technology stack](tech-stack.md) | Full library choices, workspace layout, and dependency policy |
| [Quality gates](../operations/quality.md) | Lint, format, commits, tests, scopes, and dependency review |
| [Implementation specs](../specs/README.md) | Ordered parity specs for DSH migration and remaining runtime work |
| [Implementation review 2026-11-12](../reviews/implementation-review-2026-11-12.md) | Verified baseline, findings, and the remediation rounds for the first implementation pass |

The system has five planes:

1. **Channel plane**: adapters normalize IM events into `MessageEnvelope`s and send outbound actions.
2. **Conversation plane**: `pi-durable` stores immutable entries, tasks, submissions, documents, usage, and compactions.
3. **Agent plane**: chat and workspace agents, model routing, prompt assembly, tools, plugins,
   durable prompt hooks, and policy.
   Ephemeral run state is published through the KV cache instead of being polled from durable.
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
| HTTP/API | Elysia + oRPC | Zod-validated RPC contracts mounted on Elysia |
| Frontend | React + TanStack + beUI | Router, Query, Form, and oRPC TanStack Query plugin |
| Domain storage | SQLite + Drizzle ORM | Separate from durable chat/task storage |
| Model abstraction | `@earendil-works/pi-ai` | Register Magpie and direct providers |
| Coding capability | `@earendil-works/pi-coding-agent` | Reuse session/tools/resource concepts, do not expose it directly as a bot |
| MCP | Pi MCP extension or `@earendil-works/pi-mcp` | Optional external integrations |

`pi-durable` is currently marked experimental upstream. The design therefore isolates imports behind `packages/core`, keeps version upgrades behind conformance tests, and does not let plugins touch storage internals.
