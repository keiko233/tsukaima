# tsukaima

`tsukaima` is a bot-native agent runtime built around Pi components and Bun. It replaces the current DeepSeek Harness (DSH) QQ deployment without importing AstrBot data.

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

The core implementation is in place: a Bun workspace with strict TypeScript, an
Elysia + oRPC API, a SQLite/Drizzle domain schema with automatic startup migrations,
a Pi Durable conversation host over a Bun SQLite adapter, the built-in
`onebot-napcat` channel plugin, and a React/TanStack + beUI WebUI that covers chat
objects/sessions, local Tsukaima turns, channel sends, the request inbox, settings,
diagnostics, and logging. The DSH-only migration pipeline (inspect, dry-run, import,
verify, rollback) also exists.

## Development commands

```sh
bun install
bun run check
bun run dev
```

## Key decisions

- Runtime: Bun.
- Conversation/task core: `pi-durable` over SQLite, with a Bun SQLite adapter.
- API: Elysia with oRPC procedures and Zod schemas.
- Frontend: React + TanStack Router/Query/Form, with beUI as the design system.
- Domain database: SQLite via Drizzle ORM.
- Models: `pi-ai` plus Magpie; plugins request capabilities, not concrete providers.
- Coding core: `pi-coding-agent` capabilities wrapped behind a policy-controlled Self-Iteration Runtime.
- OneBot mode: Tsukaima actively connects to NapCat's WebSocket server.
- Migration source: current DSH only.
- Deployment: fork-first Docker deployment with mainline-owned release tags; see [docs/operations/deployment.md](docs/operations/deployment.md).
- WebUI authorization: single administrator.
- WebUI authentication: Better Auth 1.7 over SQLite with native `/api/auth/*` routes.

Read [docs/architecture/README.md](docs/architecture/README.md) first. Migration-specific requirements are in [docs/migration/dsh.md](docs/migration/dsh.md).
