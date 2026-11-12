# elaina-chatbot

`elaina-chatbot` is a bot-native agent runtime built around Pi components and Bun. It replaces the current DeepSeek Harness (DSH) QQ deployment without importing AstrBot data.

## Goals

- Native IM conversations: multi-user private chats, groups, mentions, replies, stickers, images, and burst input.
- Durable conversations and background tasks with crash recovery.
- Cross-session memory scoped by user, conversation, persona, and project.
- Multi-model routing through Magpie with explicit per-capability model policy.
- A specialized self-iteration runtime that can patch, test, build, and propose deployment changes.
- An IM-style WebUI for conversations, tasks, plugin panels, and administration.
- OneBot v11 integration through outbound WebSocket connections to NapCat.

## Non-goals

- No AstrBot migration.
- No general-purpose multi-tenant bot hosting.
- No Docker socket access from the agent process.
- No public Internet exposure; the initial deployment remains LAN-only.

## Status

Design phase. The implementation repository starts with architecture documents, migration requirements, and decision records.

## Key decisions

- Runtime: Bun.
- Conversation/task core: `pi-durable` over SQLite, with a Bun SQLite adapter.
- API: Elysia with oRPC procedures and Zod schemas.
- Frontend: React + TanStack Router/Query/Form, with beUI as the design system.
- Domain database: SQLite via Drizzle ORM.
- Models: `pi-ai` plus Magpie; plugins request capabilities, not concrete providers.
- Coding core: `pi-coding-agent` capabilities wrapped behind a policy-controlled Self-Iteration Runtime.
- OneBot mode: Elaina actively connects to NapCat's WebSocket server.
- Migration source: current DSH only.
- Deployment: local development first; later distribution is a GHCR image. During development, deployment artifacts are generated for manual confirmation.
- WebUI authorization: single administrator.

Read [docs/architecture/README.md](docs/architecture/README.md) first. Migration-specific requirements are in [docs/migration/dsh.md](docs/migration/dsh.md).
