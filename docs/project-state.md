# Project state

This file is the cross-session handoff record. Update it whenever implementation phase, schema, contracts, or next actions change.

## Current status

- Project name: `tsukaima-chatbot`.
- Repository initialized at `<repo-root>` on branch `main`.
- First commit: `5dc80bc Add Tsukaima Chatbot architecture and DSH migration plan`.
- Current phase: Phase 1–7 core and library implementation complete; WebUI not scaffolded.
- Bun workspace, strict TypeScript config, lint/format checks, domain schema, Pi Durable Bun SQLite adapter, startup lifecycle, and minimal Elysia + oRPC health API exist.
- Implemented packages:
  - `packages/contracts`: message, conversation policy, activity window, submission, and admin event schemas.
  - `packages/core`: durable conversation host, activity aggregation, steering/follow-up submission, deterministic fake model, OpenAI-compatible provider, capability routing, and usage accounting.
  - `packages/onebot`: outbound WebSocket channel, NapCat event normalization, private/group send actions, access-token headers, reconnect backoff, and action timeouts.
  - `packages/coding`: self-iteration runner, worktree policy, test/build/diff tools, approval store, deployment proposal store, and local reload controller.
  - `packages/migration`: DSH snapshot inspection, session/persona/memory/sticker/settings normalization, compression hook, dry-run/import/verify/rollback pipeline.
  - `packages/sdk` and `packages/plugin-registry`: plugin manifest validation, permissions, tool/hook/UI bridges, runtime context, install/uninstall registry, and worker scaffold.
  - `packages/chaos`: transient storage failure injection, restart drill, rate limiting, idempotent ingestion, and abuse guards.
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
| OneBot mode | Tsukaima actively connects to NapCat WebSocket server |
| LLM-assisted migration | Allowed, especially for conversation compression and memory extraction |
| Project name | `tsukaima-chatbot` |

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

The current plugin design is a small Tsukaima SDK informed by Cordis, Pi coding-agent extensions, and Pi Chord. It is documented in `docs/architecture/plugin-frameworks.md`.

Current position:

- Do not adopt Cordis RC as a core dependency.
- Do not treat DSH plugins as Cordis-compatible packages.
- Use Pi concepts for the coding/self-iteration plane.
- Use Chord only as a design reference for versioned API packages, workers, reload, and UI registries.
- Keep bot plugin APIs in the Tsukaima SDK with explicit permissions and policy.

## What has not been decided yet

These are implementation-level decisions, not blockers for starting scaffolding:

1. Exact Drizzle schema version numbers and migration policy.
2. Exact oRPC procedure shape for every WebUI screen.
3. Exact plugin config validation behavior for `configSchema`.
4. Exact model policy seed values for Magpie and the OpenAI-compatible deployment.
5. Exact WebUI route/procedure surface.
7. Exact DSH session format parser behavior for every field type.
8. Exact self-iteration approval form and audit record shape.

## Implementation status

- Phase 1: durable storage conformance, conversation host, fake model, activity policy/window, admin contracts, and health lifecycle are implemented.
- Phase 2: OneBot outbound WebSocket channel and event normalization are implemented; server wiring is not yet connected.
- Phase 3: model registry/policy routing, OpenAI-compatible provider, and usage accounting are implemented; Magpie-specific deployment values are not yet seeded.
- Phase 4: plugin SDK and registry scaffold are implemented; real worker isolation, persistence, and WebUI are not yet built.
- Phase 5: coding runner, worktree policy, tools, approval/proposal stores, and reload controller are implemented as libraries.
- Phase 6: migration kit inspection/normalize/dry-run/import/verify/rollback are implemented as a library; CLI and live DSH cutover are not yet built.
- Phase 7: chaos storage, restart drill, rate limiting, idempotency, and abuse guards are implemented as libraries.

All existing tests pass:

```sh
bun test
bunx oxlint .
oxfmt --check 'apps/**/*.ts' 'packages/**/*.ts' '*.json' '*.ts' '.env.example'
```

Current test baseline: 113 passing tests across 17 files.

## Next implementation steps

Do these in order unless a later decision changes the plan:

1. Wire `apps/server` to OneBotChannel, PiDurableConversationHost, model policy routing, and plugin registry.
2. Add oRPC procedures and admin WebSocket broadcasting for conversations, activities, policies, and diagnostics.
3. Build a minimal TanStack + beUI WebUI shell.
4. Add the migration CLI on top of `packages/migration`.
5. Replace JSON approval/proposal stores with domain-backed persistence when integrating self-iteration.
6. Add real worker isolation and plugin config validation in `packages/plugin-registry`.
7. Seed Magpie/OpenAI-compatible deployment values from existing DSH docker configuration.

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
