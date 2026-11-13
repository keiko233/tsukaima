# Project state

This file is the cross-session handoff record. Update it whenever implementation phase, schema, contracts, or next actions change.

## Current status

- Project name: `tsukaima-chatbot`.
- Repository initialized at `<repo-root>` on branch `main`.
- First commit: `5dc80bc Add Tsukaima Chatbot architecture and DSH migration plan`.
- Current phase: migration-spec Phase 3 (plugin host maturity) is complete. Phase 1–7
  core/library implementation remains in place: the closed reply loop, the oRPC contract layer,
  the ingest boundary, persona/memory injection, admin authentication, plugin migrations/tasks/
  tool policy, and live WebUI updates. Remaining work starts with Phase 4 memory/context review,
  followed by the feature plugins and the DSH cutover.
- Bun workspace, strict TypeScript config, domain schema/migrations, Pi Durable Bun SQLite adapter, startup lifecycle, Elysia + oRPC API, and React/TanStack WebUI exist.
- Implemented packages:
  - `packages/contracts`: message, conversation policy, activity window, submission, and admin event schemas.
  - `packages/contracts`: additionally owns the oRPC `appContract` (`api.ts`), so every RPC
    input/output schema and every client-facing type has exactly one definition. The WebUI derives
    its client, query keys, and types from it; no hand-written wire types remain.
  - `packages/core`: durable conversation host, activity aggregation, trigger classification,
  lurk-marker handling, output normalization/stripping, per-conversation execution lock,
  steering/follow-up submission, deterministic fake model, OpenAI-compatible provider,
  capability routing, and usage accounting.
  - `plugins/onebot-napcat/src/protocol`: outbound WebSocket channel, NapCat event normalization, private/group send actions, access-token headers, reconnect backoff, and action timeouts. The former `packages/onebot` workspace was folded into the plugin, so the protocol implementation ships only with its only consumer.
  - `packages/coding`: self-iteration runner, worktree policy, test/build/diff tools, DB-backed approval/proposal stores, and local reload controller.
  - `packages/migration`: DSH snapshot inspection, session/persona/memory/sticker/settings normalization, compression hook, dry-run/import/verify/rollback pipeline.
  - `packages/sdk` and `packages/plugin-registry`: plugin manifest validation, permissions, tool/hook/UI bridges, runtime context, channel/settings/requests/audit host surfaces, install/upgrade/downgrade/quarantine lifecycle, plugin-owned migration registry, durable task/storage contracts, tool policy, declarative UI registry, and the mature Bun Worker protocol (handshake, cancellation, streamed logs/progress, host-mediated storage/audit, bounded restart, timeout/backpressure).
  - `plugins/onebot-napcat`: built-in channel plugin that owns the OneBot channel lifecycle, settings, diagnostics, and request resolution.
  - `plugins/openai-compatible`: built-in model-provider plugin. It registers a provider factory with the host; its API key, base URL, discovered multi-model catalog, enablement, and capability metadata live in plugin config and environment fallbacks, not in host runtime settings.
  - `packages/chaos`: transient storage failure injection, restart drill, rate limiting, idempotent ingestion, and abuse guards.
- Runtime target is Bun.
- Runtime settings are limited to interface/log level concerns. Provider and channel configuration are owned by their plugins; secret values are never returned by the API.
- Built-in plugins are loaded from `apps/server/src/plugins/builtin.ts`; the OneBot channel is now a plugin, not lifecycle code. `TsukaimaLifecycle` no longer holds channel, request, or identity-resolution logic.
- Assistant answers are delivered back to their origin channel by `apps/server/src/services/reply-dispatcher.ts`.
  The durable host observes the settled submission (`onAnswer`), the dispatcher claims the outbound
  row through the `(conversationId, durableEntryId)` unique index before sending, so delivery is
  at-most-once across restarts, and it emits `after.reply`. Local `webui` chats persist the same
  outbound rows without a channel send.
- Inbound envelopes are validated with `messageEnvelopeSchema` before anything is persisted, and
  identity resolution runs in a single synchronous transaction, so concurrent messages from a new
  user cannot create a duplicate user or a racing canonical identity.
- Persona and memory are injected into every model request as pi-durable prompt sections
  (`tsukaima-persona`, `tsukaima-memory`) rendered per conversation from the domain database by
  `apps/server/src/services/context-provider.ts`. Retrieval ranks by keyword overlap, then
  importance, then recency; a 4000-character budget caps the injected text, and any provider error
  degrades to no injection rather than failing the turn. Memory content is never logged.
- The admin surface uses Better Auth 1.7. Username/password sign-in, logout, session refresh, cookie
  signing, password hashing, and rate limiting are native Better Auth routes under `/api/auth/*`;
  only `auth.status` remains on oRPC. Every `admin/*` procedure and both SSE endpoints pass the
  request headers to `auth.api.getSession` and reject anonymous access with `UNAUTHENTICATED`.
  Better Auth stores `auth_user`/`auth_account`/`auth_session`/`auth_verification` in the domain
  database. The first administrator is bootstrapped from
  `TSUKAIMA_ADMIN_USERNAME`/`TSUKAIMA_ADMIN_PASSWORD`; with no stored user and no environment
  credential the whole admin surface stays locked. Sessions survive restarts and use
  `tsukaima.session_token`, `HttpOnly`, `SameSite=Lax`.
- Audit entries now accept an optional actor. Better Auth session hooks record sign-in/sign-out as
  `admin:<username>`, the RPC middleware records mutating admin calls with the same actor, and the
  old supplementary audit shim has been removed.
- Plugin tools are offered to the model. `PluginHost.tools()` aggregates every started plugin's
  `context.tools`; `createPluginToolsExtension()` adapts them to pi-durable registrations and the
  host installs one extension alongside the persona/memory sections. Permission denial and plugin
  errors become `isError` tool results instead of throwing, and every invocation writes an audit
  row. The model-facing name is `providerSafeToolName()` because OpenAI-compatible providers reject
  the `.` in the author-facing `<pluginId>.<tool>` name; routing and audit keep the original name.
- Live updates use `GET /events/stream` (SSE) and require the admin session cookie exactly like
  oRPC. It publishes `snapshot`, `heartbeat`, `message.received`, `activity.opened`,
  `activity.closed`, `before.reply`, and `after.reply`. The WebUI keeps one `EventSource`, validates
  each frame with `liveEventSchema`, and invalidates the affected TanStack Query keys instead of
  polling. `GET /events/logs` is authenticated the same way.
- Plugin configuration lives in the domain `meta` table under `plugin-config:<pluginId>` with `manifest.configEnv` fallbacks. `/admin/settings` exposes only host settings (`logLevel`, active `modelProviderId`) plus generic plugin config views; the former `onebot*` and `openAi*` wire aliases are gone.
- `adminBase` authenticates every admin procedure and audits only procedures whose contract metadata says `audit: true`. Mutations are declared in `packages/contracts/src/api.ts`; successful and failed calls both produce an `admin.rpc` row, and adding a new mutation cannot silently bypass audit by forgetting a path list.
- Plugin host surfaces now include `models.registerProvider`, `rpc.register`, and `ui.register` aggregation. The model provider factory can report `isConfigured()`; the lifecycle falls back to the deterministic fake model when the provider is absent, unconfigured, or fails to build.
- `TsukaimaPlugin.prepare(context)` runs before the conversation host is built, so model providers and other host-surface registrations exist before model selection. `setup(context)` still runs later for channel adapters and runtime work.
- OneBot settings apply live through the plugin's `settings.onChange`: changing the WebSocket URL or access token restarts the channel and reconnects without a server restart. Provider settings still require a restart.
- Runtime logging uses structured records rendered in Rust `tracing` style, with a bounded in-memory buffer, SSE delivery, and a Shiki ANSI-rendered diagnostics viewer.
- TanStack file-based routing, Paraglide i18n (`en`, `zh-cn`), TanStack Query data wiring, and beUI components under `apps/web/src` are active.
- WebUI routes are grouped under `(messaging)` and `(system)`. Route-specific code lives in the matching `_modules` directory; shared shell code lives in `routes/_modules`.
- `chat_objects` is separate from `conversations`, which now represents Tsukaima sessions. Each external chat object has one explicit receiving session for new messages.
- Incoming messages are protected by a durable message receipt plus `(chat_object_id, platform_message_id)` uniqueness. Activity windows flush after inactivity and resume after restart.
- The request inbox persists OneBot friend/group request events separately from chat turns. Decisions are capability- and connection-aware; timeouts remain uncertain.
- Conversation policy is a versioned durable document (`tsukaima.conversationPolicy`) owned by the
  domain `policies` table. Global defaults inherit into conversation overrides, every update
  writes a new active revision and keeps previous rows with `isActive = 0` for history. The
  policy owns access (`privateAccess`/`groupAccess`), allowlist/keywords/aliases/peer bots,
  burst/cooldown/rate limits, quiet hours, output pacing, and the tool allowlist.
- Inbound activity is classified as `direct`, `soft`, `ambient`, or `ignored`. Ignored traffic is
  dropped before `messages` and the durable host, with a cumulative counter plus a rate-limited
  `conversation.trigger-ignored` audit row. Ambient messages persist with
  `messages.trigger_classification = 'ambient'` and group context but never enter the activity
  window. Direct/soft turns receive a compact trigger contract and the model may return
  `TSUKAIMA_LURK`; that marker is suppressed before outbound history/channel dispatch and recorded
  as an audited no-send (`message.lurk`).
- Burst settle, max-wait, max-count, long-message immediate submission, cooldown/rate-limit
  aggregation, and steer-then-follow-up all run under a shared per-conversation execution lock.
  Outbound delivery strips Markdown, splits newline units (preserving fenced code), applies the
  immediate-message cap, optional typing/delay, send intervals, and per-conversation cancellation
  on new inbound turns.
- Personas are versioned rows with explicit `aliases_json` (shared with trigger aliases) and
  active-version filtering. `persona_bindings` supports global, chat-kind, chat-object, and
  conversation scopes; resolution is conversation/chat-object > chat-kind > global. The compact
  identity and conversation-policy prompt sections render before memory.
- The WebUI conversation view exposes conversation rules (trigger/access, pacing, quiet hours,
  rate limit, output chunking/delay/typing/Markdown, tool allowlist, persona binding, and policy
  history). All mutations use authenticated oRPC admin routes and are audited.

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
| Authentication            | Better Auth with SQLite-backed users and sessions                                       |
| OneBot mode               | Tsukaima actively connects to NapCat WebSocket server                                     |
| LLM-assisted migration    | Allowed, especially for conversation compression and memory extraction                  |
| Project name              | `tsukaima-chatbot`                                                                        |

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
6. Exact DSH session format parser behavior for every field type.
7. Exact self-iteration approval form and audit record shape.

## Implementation status

- Phase 1: durable storage conformance, conversation host, fake model, activity policy/window, admin contracts, and health lifecycle are implemented.
- Phase 2: OneBot outbound WebSocket is connected in lifecycle startup; inbound envelopes are normalized, deduplicated by domain conversation key, and routed to reusable durable conversations. The migration-spec conversation policy, trigger classification/lurk handling, cooldown/burst queues, humanlike output pacing, persona binding precedence, and admin policy/persona UI/API are implemented.
- Phase 3: model registry/policy routing, OpenAI-compatible provider, provider settings, and usage accounting are implemented; live Magpie deployment values can be supplied through WebUI settings or environment variables.
- Migration-spec Phase 3: plugin migrations, durable plugin storage/tasks, layered tool policy, ordered reply transforms, declarative UI components, granular channel/model capabilities, install lifecycle/quarantine, and the mature worker contract are implemented.
- Phase 4: plugin SDK, registry, config validation, bridges, admin WebUI, and real Bun Worker isolation are implemented.
- Phase 5: coding runner, worktree policy, tools, DB-backed approval/proposal stores, and reload controller are implemented.
- Phase 6: migration inspection/normalize/dry-run/import/verify/rollback, CLI, and persona/memory/sticker/settings import pipeline are implemented; live DSH cutover has not been executed.
- Phase 7: chaos storage, restart drill, rate limiting, idempotency, and abuse guards are implemented as libraries.

All existing tests pass:

```sh
bun run check
```

Current baseline: lint, formatting, root TypeScript, WebUI TypeScript, WebUI production
build, WebUI i18n checks, and 303 tests across 63 files pass.

## Next implementation steps

Follow the ordered implementation specs in `docs/specs/README.md`:

1. **Phases 0–1**: Finish the DSH baseline/audit and NapCat operational parity. Phase 2
   conversation policy/pacing and Phase 3 plugin host maturity are complete.
2. **Phases 4–8**: Memory and context extraction/review, `sticker-meme`, `search-fetch`,
   `proactive-scheduler`, and `self-iteration` runtime/UI.
3. **Phase 9**: Full DSH v4 snapshot/import/verify/rollback migration and NapCat cutover.
4. **Release readiness**: Schema/contract cleanup (`messages.activity_id`, duplicated schemas), Playwright E2E suite, secret scanning, backup/restore drills, and the production runbook.

The full built-in plugin inventory and migration order are tracked in
`docs/architecture/builtin-plugin-migration.md`.

## Current known limitations

- One inbound message is answered when its activity window settles (roughly
  `pacing.burstSettleMs`, 6 s by default), unless a long message or max-wait forces an earlier
  submission. Tune the policy or add an immediate first-message path.
- Reply delivery is at-most-once: a crash between claiming the outbound row and a successful send
  leaves a permanent `pending` row with no reconciliation job yet.
- Answers with no text blocks (tool-only) produce no reply. Output is now newline-chunked and
  platform-length split per unit, but there is still no media-aware unit grouping.
- `messages.activity_id` is a dangling column: the `activities` tables were dropped while the
  column stayed.
- `remoteModelsInputSchema` and `runtimeSettingsPatchSchema` exist both in `apps/server/src` and
  in `packages/contracts`; one definition should move.
- Better Auth sign-in throttling is per client IP. Direct connections use Bun's socket peer
  address; reverse proxies must be listed in `TSUKAIMA_TRUSTED_PROXIES` before their forwarded chain
  is trusted. There is no password-rotation UI or multi-admin model yet. Migration `0005` drops the legacy
  `admin_credentials` table; an existing deployment must have the bootstrap env values available
  for the first run after upgrade or use a dedicated credential-import tool.
- Hook payloads are asymmetric: `activity.opened`/`activity.closed` carry durable ids while
  `before.reply`/`after.reply` carry domain ids. `task.created`/`task.completed` now emit from the
  host task service.
- SSE has no `Last-Event-ID` replay; a reconnect relies on the fresh `snapshot` followed by
  re-query, and a logout does not tear down an already-open stream (it is authorised at connect
  time).
- The tool name the model sees is still a hashed provider-safe alias; plugin routing and audit use
  the original `<pluginId>.<action>` name.
- Declarative UI components are host-rendered data cards; runtime-installed third-party React
  panels still require the future iframe sandbox rather than the trusted build-time tier.
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
