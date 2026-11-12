# Project state

This file is the cross-session handoff record. Update it whenever implementation phase, schema, contracts, or next actions change.

## Current status

- Project name: `elaina-chatbot`.
- Repository initialized at `/home/keiko/Code/elaina-chatbot` on branch `main`.
- First commit: `5dc80bc Add Elaina Chatbot architecture and DSH migration plan`.
- Current phase: Phase 1–7 core/library implementation complete; the WebUI now implements the messaging-workspace shell, chat-object/session navigation, local Elaina turns, channel sends, directory views, and request inbox.
- Bun workspace, strict TypeScript config, domain schema/migrations, Pi Durable Bun SQLite adapter, startup lifecycle, Elysia + oRPC API, and React/TanStack WebUI exist.
- Implemented packages:
  - `packages/contracts`: message, conversation policy, activity window, submission, and admin event schemas.
  - `packages/core`: durable conversation host, activity aggregation, steering/follow-up submission, deterministic fake model, OpenAI-compatible provider, capability routing, and usage accounting.
  - `packages/onebot`: outbound WebSocket channel, NapCat event normalization, private/group send actions, access-token headers, reconnect backoff, and action timeouts.
  - `packages/coding`: self-iteration runner, worktree policy, test/build/diff tools, DB-backed approval/proposal stores, and local reload controller.
  - `packages/migration`: DSH snapshot inspection, session/persona/memory/sticker/settings normalization, compression hook, dry-run/import/verify/rollback pipeline.
  - `packages/sdk` and `packages/plugin-registry`: plugin manifest validation, permissions, tool/hook/UI bridges, runtime context, install/uninstall registry, and real Bun Worker isolation.
  - `packages/chaos`: transient storage failure injection, restart drill, rate limiting, idempotent ingestion, and abuse guards.
- Runtime target is Bun.
- Runtime settings for log level, OneBot, and OpenAI-compatible/Magpie provider configuration are persisted in the domain database and editable from the WebUI. Secret values are never returned by the API.
- OneBot settings resolve from runtime settings with environment fallback and apply live: changing the WebSocket URL or access token restarts the channel and reconnects without a server restart. Provider settings still require a restart.
- Runtime logging uses structured records rendered in Rust `tracing` style, with a bounded in-memory buffer, SSE delivery, and a Shiki ANSI-rendered diagnostics viewer.
- TanStack file-based routing, Paraglide i18n (`en`, `zh-cn`), TanStack Query data wiring, and beUI components under `apps/web/src` are active.
- WebUI routes are grouped under `(messaging)` and `(system)`. Route-specific code lives in the matching `_modules` directory; shared shell code lives in `routes/_modules`.
- `chat_objects` is separate from `conversations`, which now represents Elaina sessions. Each external chat object has one explicit receiving session for new messages.
- Incoming messages are protected by a durable message receipt plus `(chat_object_id, platform_message_id)` uniqueness. Activity windows flush after inactivity and resume after restart.
- The request inbox persists OneBot friend/group request events separately from chat turns. Decisions are capability- and connection-aware; timeouts remain uncertain.

## Confirmed decisions

| Topic                     | Decision                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Runtime                   | Bun                                                                                     |
| Conversation/task core    | `pi-durable` over SQLite with a local Bun SQLite adapter                                |
| Domain database           | SQLite through Drizzle ORM, separate file from durable storage                          |
| HTTP framework            | Elysia                                                                                  |
| RPC                       | oRPC with Zod schemas                                                                   |
| Frontend framework        | React                                                                                   |
| Router                    | TanStack Router                                                                         |
| Server-state              | TanStack Query                                                                          |
| Forms                     | TanStack Form                                                                           |
| UI                        | beUI design system through its shadcn-compatible registry                               |
| Migration source          | Current DSH only; AstrBot is not migrated                                               |
| Downtime during cutover   | Allowed                                                                                 |
| Self-iteration deployment | Local development first; agent creates deployment proposals/artifacts; later GHCR image |
| WebUI authorization       | One administrator                                                                       |
| OneBot mode               | Elaina actively connects to NapCat WebSocket server                                     |
| LLM-assisted migration    | Allowed, especially for conversation compression and memory extraction                  |
| Project name              | `elaina-chatbot`                                                                        |

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
- `docs/architecture/logging.md`
- `docs/migration/dsh.md`
- `docs/migration/migration-kit.md`
- `docs/roadmap.md`
- `docs/operations/quality.md`
- ADRs 0001–0007

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
3. Exact plugin config validation behavior for `configSchema`.
4. Exact model policy seed values for Magpie and the OpenAI-compatible deployment.
5. Exact WebUI route/procedure surface.
6. Exact DSH session format parser behavior for every field type.
7. Exact self-iteration approval form and audit record shape.

## Implementation status

- Phase 1: durable storage conformance, conversation host, fake model, activity policy/window, admin contracts, and health lifecycle are implemented.
- Phase 2: OneBot outbound WebSocket is connected in lifecycle startup; inbound envelopes are normalized, deduplicated by domain conversation key, and routed to reusable durable conversations.
- Phase 3: model registry/policy routing, OpenAI-compatible provider, provider settings, and usage accounting are implemented; live Magpie deployment values can be supplied through WebUI settings or environment variables.
- Phase 4: plugin SDK, registry, config validation, bridges, admin WebUI, and real Bun Worker isolation are implemented.
- Phase 5: coding runner, worktree policy, tools, DB-backed approval/proposal stores, and reload controller are implemented.
- Phase 6: migration inspection/normalize/dry-run/import/verify/rollback, CLI, and persona/memory/sticker/settings import pipeline are implemented; live DSH cutover has not been executed.
- Phase 7: chaos storage, restart drill, rate limiting, idempotency, and abuse guards are implemented as libraries.

All existing tests pass:

```sh
bun run check
```

Current baseline: lint, formatting, root TypeScript, WebUI TypeScript, WebUI production
build, and 137 tests across 27 files pass.

## Next implementation steps

Do these in order unless a later decision changes the plan:

1. Add authenticated admin sessions and live WebSocket updates for conversations, activities, and diagnostics beyond the new log stream.
2. Add full persona/memory/audit admin services and review UI.
3. Add production memory extraction/retrieval jobs and persona seeding operations.
4. Add sticker/meme and search plugins plus plugin worker supervision in the server lifecycle.
5. Add task graph/audit visualization for self-iteration.
6. Run the real DSH import, verify data, and cut NapCat from DSH to Elaina.
7. Add secret scanning, backup/restore drills, and the production runbook.

## Current WebUI limitations

- Assistant replies to external channel messages are visible in the WebUI but are not yet automatically sent back through OneBot.
- The chat list preview is backed by indexed domain messages; an assistant-only latest turn may not update the parent preview.
- Unread state, chat-object pin/archive controls beyond session archive, and group management actions are not implemented.
- Narrow-screen navigation is implemented, but no Playwright end-to-end suite is present yet.

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
