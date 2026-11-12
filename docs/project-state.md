# Project state

This file is the cross-session handoff record. Update it whenever implementation phase, schema, contracts, or next actions change.

## Current status

- Project name: `elaina-chatbot`.
- Repository initialized at `/home/keiko/Code/elaina-chatbot` on branch `main`.
- First commit: `5dc80bc Add Elaina Chatbot architecture and DSH migration plan`.
- Current phase: architecture and detailed design, before implementation.
- No production code has been added yet.
- Runtime target is Bun.
- Frontend and API stack are selected but not scaffolded.

## Confirmed decisions

| Topic | Decision |
| --- | --- |
| Runtime | Bun |
| Conversation/task core | `pi-durable` over SQLite with a local Bun SQLite adapter |
| Domain database | SQLite through Drizzle ORM, separate file from durable storage |
| HTTP framework | Elysia |
| RPC | oRPC with Zod schemas |
| Frontend framework | React |
| Router | TanStack Router |
| Server-state | TanStack Query |
| Forms | TanStack Form |
| UI | beUI design system through its shadcn-compatible registry |
| Migration source | Current DSH only; AstrBot is not migrated |
| Downtime during cutover | Allowed |
| Self-iteration deployment | Local development first; agent creates deployment proposals/artifacts; later GHCR image |
| WebUI authorization | One administrator |
| OneBot mode | Elaina actively connects to NapCat WebSocket server |
| LLM-assisted migration | Allowed, especially for conversation compression and memory extraction |
| Project name | `elaina-chatbot` |

## Design documents already written

- `README.md`
- `docs/architecture/README.md`
- `docs/architecture/runtime.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/plugins.md`
- `docs/architecture/self-iteration.md`
- `docs/architecture/web-ui.md`
- `docs/architecture/model-routing.md`
- `docs/architecture/tech-stack.md`
- `docs/migration/dsh.md`
- `docs/migration/migration-kit.md`
- `docs/roadmap.md`
- `docs/operations/quality.md`
- ADRs 0001–0005

This file may fall behind individual documents during rapid edits, but the documents above should always contain the most detailed truth.

## Plugin framework evaluation

The current plugin design is a small Elaina SDK informed by Cordis, Pi coding-agent extensions, and Pi Chord. It is documented in `docs/architecture/plugin-frameworks.md`.

Current position:

- Do not adopt Cordis RC as a core dependency.
- Do not treat DSH plugins as Cordis-compatible packages.
- Use Pi concepts for the coding/self-iteration plane.
- Use Chord only as a design reference for versioned API packages, workers, reload, and UI registries.
- Keep bot plugin APIs in the Elaina SDK with explicit permissions and policy.

## What has not been decided yet

These are implementation-level decisions, not blockers for starting scaffolding:

1. Exact Drizzle schema version numbers and migration policy.
2. Exact oRPC procedure shape for every WebUI screen.
3. Exact plugin manifest JSON format and validation schema.
4. Exact durable document kinds for conversation metadata, policy, aggregation, and media.
5. Exact OneBot event/action schema definitions.
6. Exact model policy seed values for Magpie.
7. Exact DSH session format parser behavior for every field type.
8. Exact self-iteration approval form and audit record shape.

## Next implementation steps

Do these in order unless a later decision changes the plan:

1. Create Bun workspace:
   - `apps/server`
   - `apps/web`
   - `packages/contracts`
   - `packages/core`
   - `packages/durable`
   - `packages/db`
   - `packages/onebot`
   - `packages/coding`
   - `packages/migration`
2. Add TypeScript strict config, oxlint, oxfmt, commitlint, lint-staged, Husky.
3. Add Drizzle with `domain.sqlite` schema for identities, conversations metadata, personas, memory, plugins, policy, audit, media, migration ledger.
4. Implement `BunSqliteStorage` adapter against `pi-durable`'s SQLite interface.
5. Build fake model and fake OneBot channel fixtures.
6. Implement minimal Elysia + oRPC host.
7. Build a minimal TanStack + beUI WebUI shell.
8. Connect fake model and fake channel to a durable conversation and verify steering/follow-up.
9. Implement real OneBot normalization only after the fake path is stable.

## How to resume in a new session

1. Read this file first.
2. Read `docs/architecture/README.md`.
3. Read `docs/architecture/tech-stack.md` and `docs/architecture/database.md` for scaffolding.
4. Read `docs/architecture/conversation-flow.md`, `docs/architecture/api.md`, and `docs/architecture/plugin-sdk.md` for runtime behavior.
5. Read `docs/migration/dsh.md` when touching migration.
6. Check `git status` and `git log` for uncommitted work.
7. Do not invent new high-level decisions without checking whether an ADR already exists.

## Conventions for updating project state

- Mark an item complete only after code/tests/docs exist.
- If a decision changes, update the relevant ADR and this file.
- Keep the "Next implementation steps" list concrete and ordered.
- Do not store secrets, tokens, QQ content, or DSH session content here.
