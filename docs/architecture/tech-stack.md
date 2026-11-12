# Technology stack

## Principles

- Prefer mature libraries over custom infrastructure.
- Keep type safety end to end: Zod at the boundary, oRPC contracts in the middle, typed components at the UI.
- Keep domain logic independent from Bun, Elysia, and React so it can be tested directly.
- Avoid duplicating contracts between server and client.
- Pin versions and review all new dependencies.

## Runtime and package management

- Runtime: Bun.
- Package manager and task runner: Bun workspaces.
- Language: TypeScript strict mode.
- Target: Bun-compatible TypeScript with no runtime-only code in shared packages.

Expected workspace layout:

```text
apps/
  server/       Elysia + oRPC host
  web/          TanStack React app
packages/
  contracts/    oRPC routers, Zod schemas, shared error types
  core/         conversation, memory, persona, policy, plugin domain services
  durable/      pi-durable host and Bun SQLite adapter
  db/           Drizzle schema and migrations
  onebot/       OneBot/NapCat adapter
  coding/       self-iteration runtime policies and tools
  migration/    DSH migration domain logic
tools/
  migration/    Bun CLI entry
```

The layout is a target, not a rigid rule. Small helper packages can be merged if ownership is clear.

## Server and API

- HTTP/WebSocket framework: `elysia`.
- RPC layer: `oRPC`.
- Schema/validation: `zod`.
- Mounting: oRPC Fetch adapter on an Elysia wildcard route, with Elysia body parsing disabled for RPC routes.
- Contracts: oRPC routers are the single source of API types; do not manually mirror types in the client.
- Errors: typed oRPC errors with stable codes for UI display.
- Auth: Better Auth with SQLite-backed sessions; only one administrator initially.
- Cross-cutting middleware: request ID, logging, auth context, rate limiting, audit context.
- Static assets are served from the built WebUI output in production.

Rules:

- Public HTTP routes are limited to health checks, auth, static assets, and oRPC entry points.
- Long-lived realtime data uses oRPC streamed/live procedures or Elysia WebSocket, not ad-hoc JSON polling.
- Every state-changing procedure performs Zod validation, permission checks, and audit logging.
- Plugin and admin APIs have separate contract namespaces.

## Frontend

- Framework: React.
- Build tool: Vite.
- Router: TanStack Router with file-based routes and typed search params.
- Server state: TanStack Query.
- Forms: TanStack Form.
- RPC client: `@orpc/tanstack-query` utilities built from the shared oRPC client.
- UI library/design language: beUI.
- Styling: Tailwind CSS, aligned with beUI tokens.
- Animation: Motion, as required by beUI components.

beUI provides conversational primitives useful to Tsukaima, including message bubbles, message scrollers, prompt input, streaming response, agent activity, tool result, file diff, approval card, and chat app layouts. Components are added through its shadcn-compatible registry:

```sh
bunx --bun shadcn add @beui/message-scroller
bunx --bun shadcn add @beui/agent-activity
bunx --bun shadcn add @beui/approval-card
```

Use beUI as the default visual language. Custom components are allowed only when beUI has no suitable primitive, and they should reuse the same tokens and motion conventions.

Frontend state rules:

- Server state belongs in TanStack Query.
- Route-local and ephemeral UI state stays local.
- Optimistic updates are used only for safe actions such as renaming or pinning.
- Streaming replies use oRPC streamed/live query utilities when appropriate.
- Durable task and conversation watches invalidate the corresponding query keys.

## Data

- Domain database: SQLite through `drizzle-orm/bun-sqlite`.
- Migrations: `drizzle-kit`.
- Durable chat/task storage: `pi-durable` over SQLite through the local Bun adapter.
- Database files:
  - `durable.sqlite`: conversations, entries, tasks, documents, usage, compactions.
  - `domain.sqlite`: users, personas, memory, plugin registry, policies, audit, migration ledger, media index.
- Attachments: content-addressed files plus SQLite metadata.

Use Drizzle for explicit domain schema and queries. Use `pi-durable` APIs for conversation/task operations. Do not write directly to durable tables from domain services.

## Agent, plugins, and channels

- Model abstraction: `pi-ai`.
- Durable conversations/tasks: `pi-durable`.
- Coding capability: `pi-coding-agent` concepts wrapped behind the Self-Iteration Runtime.
- MCP: Pi MCP extension or `@earendil-works/pi-mcp` for external tools.
- OneBot/NapCat: outbound WebSocket client in the `onebot` package.
- Schema parsing: Zod for channel envelopes and plugin configs.

## Configuration, logging, and diagnostics

- Configuration is loaded from environment/files and validated with Zod.
- Secrets come only from mounted secret files or environment; never from the database or Git.
- Logging: structured events rendered in Rust `tracing` style, with request ID, channel ID, conversation ID, task ID, and plugin name.
- Diagnostics: a bounded in-memory log buffer exposed through oRPC and SSE, with ANSI output rendered by Shiki in the WebUI.
- Audit: append-only records in SQLite for sends, administrative changes, memory edits, plugin permission changes, and deployment proposals.
- Health endpoints expose process, database, channel, model gateway, and plugin-worker status.

## Startup and migrations

- Application startup owns all required migrations.
- `pi-durable` migrations run when durable storage opens.
- Drizzle migrations run on `domain.sqlite` before services initialize.
- The HTTP listener can bind before channels start, but `/readyz` becomes healthy only after required migrations, services, plugins, scheduler, and channels are ready.
- Do not rely on a manual migration command in production. A separate CLI may exist for development and maintenance.

See [startup-lifecycle.md](startup-lifecycle.md).
See [logging.md](logging.md) for log fields, retention, transports, and rendering.

## Testing

Primary test runner: Bun test.

Layers:

1. Unit tests for pure domain logic and Zod schemas.
2. Adapter tests for Bun SQLite and OneBot normalization.
3. Contract tests for oRPC routers with fake services.
4. Integration tests using fake model and fake OneBot adapter.
5. End-to-end WebUI tests with Playwright for critical admin and chat flows.

Every durable adapter and channel adapter must have restart tests. No test sends real QQ messages.

## Code quality and Git hooks

- Linter: `oxlint`.
- Formatter: `oxfmt`.
- Type checking: TypeScript compiler.
- Commit message validation: `commitlint` with Conventional Commits.
- Pre-commit runner: `lint-staged`.
- Hook manager: `husky`.

Expected scripts:

```json
{
  "scripts": {
    "lint": "oxlint .",
    "format": "oxfmt 'apps/**/*.ts' 'packages/**/*.ts' '*.json' '*.ts' '.env.example'",
    "format:check": "oxfmt --check 'apps/**/*.ts' 'packages/**/*.ts' '*.json' '*.ts' '.env.example'",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "check": "bun run lint && bun run format:check && bun run typecheck && bun run test",
    "prepare": "husky"
  }
}
```

`lint-staged` runs on staged files:

```json
{
  "*.{ts,tsx,js,jsx,json,yaml,yml}": [
    "oxfmt --write",
    "oxlint --fix"
  ]
}
```

`commitlint` enforces Conventional Commits, for example:

```text
feat(core): add activity aggregation
fix(onebot): deduplicate reconnect events
docs(migration): expand DSH cutover steps
```

Pre-commit must not run the full test suite by default if it makes iteration slow. It should format and lint staged files. CI runs the full `check` pipeline.

## Dependency policy

- Add a dependency only when it saves meaningful complexity.
- Prefer packages already used by Pi, Elysia, oRPC, TanStack, or beUI.
- Avoid overlapping libraries for the same concern.
- Avoid runtime dependencies in `packages/contracts` except Zod and oRPC types.
- Review every new dependency for Bun compatibility, maintenance activity, and security.
- Lock dependency versions in `bun.lock`.

## Development commands

```sh
bun install
bun run dev          # server + web in development
bun run lint
bun run format
bun run typecheck
bun run test
bun run check
```
