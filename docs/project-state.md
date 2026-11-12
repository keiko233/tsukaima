# Project state

This file is the cross-session handoff record. Update it whenever implementation phase, schema, contracts, or next actions change.

## Current status

- Project name: `elaina-chatbot`.
- Repository initialized at `/home/keiko/Code/elaina-chatbot` on branch `main`.
- First commit: `5dc80bc Add Elaina Chatbot architecture and DSH migration plan`.
- Current phase: Phase 1–7 core/library implementation complete; the closed reply loop, the oRPC
  contract layer, the ingest boundary, persona/memory injection, and admin authentication are in
  place. Remaining work is realtime push, plugin tool bridging, and the DSH cutover itself.
- Bun workspace, strict TypeScript config, domain schema/migrations, Pi Durable Bun SQLite adapter, startup lifecycle, Elysia + oRPC API, and React/TanStack WebUI exist.
- Implemented packages:
  - `packages/contracts`: message, conversation policy, activity window, submission, and admin event schemas.
  - `packages/contracts`: additionally owns the oRPC `appContract` (`api.ts`), so every RPC
    input/output schema and every client-facing type has exactly one definition. The WebUI derives
    its client, query keys, and types from it; no hand-written wire types remain.
  - `packages/core`: durable conversation host, activity aggregation, steering/follow-up submission, deterministic fake model, OpenAI-compatible provider, capability routing, and usage accounting.
  - `packages/onebot`: outbound WebSocket channel, NapCat event normalization, private/group send actions, access-token headers, reconnect backoff, and action timeouts.
  - `packages/coding`: self-iteration runner, worktree policy, test/build/diff tools, DB-backed approval/proposal stores, and local reload controller.
  - `packages/migration`: DSH snapshot inspection, session/persona/memory/sticker/settings normalization, compression hook, dry-run/import/verify/rollback pipeline.
  - `packages/sdk` and `packages/plugin-registry`: plugin manifest validation, permissions, tool/hook/UI bridges, runtime context, channel/settings/requests/audit host surfaces, install/uninstall registry, and real Bun Worker isolation.
  - `plugins/onebot-napcat`: built-in channel plugin that owns the OneBot channel lifecycle, settings, diagnostics, and request resolution.
  - `packages/chaos`: transient storage failure injection, restart drill, rate limiting, idempotent ingestion, and abuse guards.
- Runtime target is Bun.
- Runtime settings for log level and OpenAI-compatible/Magpie provider configuration are persisted in the domain database and editable from the WebUI. Secret values are never returned by the API.
- Built-in plugins are loaded from `apps/server/src/plugins/builtin.ts`; the OneBot channel is now a plugin, not lifecycle code. `ElainaLifecycle` no longer holds channel, request, or identity-resolution logic.
- Assistant answers are delivered back to their origin channel by `apps/server/src/services/reply-dispatcher.ts`.
  The durable host observes the settled submission (`onAnswer`), the dispatcher claims the outbound
  row through the `(conversationId, durableEntryId)` unique index before sending, so delivery is
  at-most-once across restarts, and it emits `after.reply`. Local `webui` chats persist the same
  outbound rows without a channel send.
- Inbound envelopes are validated with `messageEnvelopeSchema` before anything is persisted, and
  identity resolution runs in a single synchronous transaction, so concurrent messages from a new
  user cannot create a duplicate user or a racing canonical identity.
- Persona and memory are injected into every model request as pi-durable prompt sections
  (`elaina-persona`, `elaina-memory`) rendered per conversation from the domain database by
  `apps/server/src/services/context-provider.ts`. Retrieval ranks by keyword overlap, then
  importance, then recency; a 4000-character budget caps the injected text, and any provider error
  degrades to no injection rather than failing the turn. Memory content is never logged.
- The admin surface is authenticated. `auth.status`/`login`/`logout` are public; every `admin/*`
  procedure is bound to an `adminBase` guard that returns `UNAUTHENTICATED` without a session.
  Credentials are argon2id hashes bootstrapped from `ELAINA_ADMIN_USERNAME`/`ELAINA_ADMIN_PASSWORD`
  into `admin_credentials`; with neither stored nor environment credentials the whole admin surface
  stays locked. Sessions are in-memory (restart requires a new sign-in) with httpOnly,
  `SameSite=Lax` cookies. The WebUI gates the shell behind `auth.status` and has a `/login` route.
- Plugin configuration lives in the domain `meta` table under `plugin-config:<pluginId>` with `manifest.configEnv` fallbacks. `/admin/settings` keeps its `onebot*` fields as a legacy alias mapped onto the `onebot-napcat` plugin config, so the WebUI contract is unchanged.
- OneBot settings apply live through the plugin's `settings.onChange`: changing the WebSocket URL or access token restarts the channel and reconnects without a server restart. Provider settings still require a restart.
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
- `docs/reviews/implementation-review-2026-11-12.md`
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
build, and 166 tests across 34 files pass.

## Next implementation steps

Do these in order unless a later decision changes the plan:

1. Add live WebSocket/SSE updates for conversations, activities, and diagnostics beyond the log
   stream, so the WebUI stops polling.
2. Bridge plugin tools into the model run and give `task.created`/`task.completed` real emission
   points, or document the deliberate reduction to channel/admin extension points.
3. Give `packages/sdk`'s `AuditEntry` an optional `actorId` and thread it through
   `ElainaLifecycle.writeAudit`, replacing the RPC-layer audit shim.
4. Decide the auth provider question recorded in `docs/architecture/api.md`: adopt a mature library
   (Better Auth or equivalent) or keep the in-house service deliberately.
5. Extract the model provider into `plugins/openai-compatible` (phase C of `plugin-decoupling.md`); this needs the `models.registerProvider` host surface.
6. Add full persona/memory/audit admin services and review UI, plus memory extraction jobs.
7. Add sticker/meme and search plugins plus plugin-owned database migrations.
8. Add task graph/audit visualization for self-iteration.
9. Run the real DSH import, verify data, and cut NapCat from DSH to Elaina.
10. Add secret scanning, backup/restore drills, and the production runbook.

## Current known limitations

- One inbound message is answered only when its activity window flushes, so a single DM waits
  roughly `policy.windowMs` (6 s) before the model run starts. Tune the default or add an
  immediate first-message path.
- Reply delivery is at-most-once: a crash between claiming the outbound row and a successful send
  leaves a permanent `pending` row with no reconciliation job yet.
- Replies are sent as one text part; there is no platform length chunking, and answers with no
  text blocks (tool-only) produce no reply.
- `messages.activity_id` is a dangling column: the `activities` tables were dropped while the
  column stayed.
- `remoteModelsInputSchema` and `runtimeSettingsPatchSchema` exist both in `apps/server/src` and
  in `packages/contracts`; one definition should move.
- Admin authentication is in-house; the auth-library decision is open (see `api.md`). Login
  throttling is global rather than per-IP, the session cookie has no `Secure` attribute (LAN HTTP),
  there is no password rotation, and sessions do not survive a restart.
- Hook payloads are asymmetric: `activity.opened`/`activity.closed` carry durable ids while
  `before.reply`/`after.reply` carry domain ids, and `task.created`/`task.completed` are declared
  with no emission point.
- Unread state, chat-object pin/archive controls beyond session archive, and group management
  actions are not implemented.
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
