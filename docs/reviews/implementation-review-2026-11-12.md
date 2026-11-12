# Implementation review — 2026-11-12

Scope: the first implementation pass on top of the architecture documents. Reviewed by
running the project, reading every workspace package, and probing the live server.

## Verified baseline

At review time the repository was green:

```sh
bun run check                     # lint, format, typecheck, 145 tests / 29 files
bun run --filter '@tsukaima/web' build
```

The server also boots and answers correctly:

```sh
TSUKAIMA_DATA_DIR=$(mktemp -d) TSUKAIMA_PORT=7499 bun run apps/server/src/main.ts
curl http://127.0.0.1:7499/healthz        # {"state":"ready",...}
curl -o /dev/null -w '%{http_code}' http://127.0.0.1:7499/readyz   # 204
curl -X POST http://127.0.0.1:7499/rpc/admin/plugins/list -d '{}'
```

## What is solid

- Degradation is designed, not accidental: a failed `OneBotChannelAdapter.start` records
  `restartRequired` and leaves the process `ready` instead of failing boot; an unconfigured
  channel stays idle.
- Deduplication is layered and concurrency-aware: a durable message receipt, the
  `(chat_object_id, platform_message_id)` unique index, and the
  `conversations_one_receiving_unique` partial index that arbitrates racing receivers.
- The activity window semantics are correct: submitting marks the window `submitted`, a new
  envelope opens a fresh window (no lost messages), and `resumeActivityWindow` re-arms the
  timer after a restart.
- The OneBot/NapCat extraction is clean: `settings.onChange` plus a restart key recreates the
  connection only when the live connection parameters actually change.
- Plugin configuration never returns secrets through the API, and `configEnv` fallbacks
  resolve in the documented stored-then-environment order.
- The migration pipeline has dry-run, import, verify, rollback, and a ledger;
  `migrateDomainDatabase` runs inside the startup sequence.
- The Bun SQLite adapter serializes operations, uses `BEGIN IMMEDIATE`, and enables WAL.

## Findings

### P0 — the bot could not answer anyone

1. **No outbound reply loop.** Inbound messages reach `PiDurableConversationHost`, and the
   model produces a `pi.assistant` entry, but nothing sends that answer back through the
   channel. The only outbound path was the manual WebUI `target: "channel"` send in
   `apps/server/src/services/webui.ts`. The `after.reply` hook was declared
   (`packages/sdk/src/types.ts`) and never emitted; `apps/server/src/lifecycle.ts` emitted only
   `message.received`. The WebUI showed replies by synthesizing them from durable entries at
   read time (`assistantMessagesFromEntries`), which hid the gap.
2. **The oRPC contract was never landed.** The server inlined `z.object` per handler in
   `apps/server/src/rpc/admin.ts`; the WebUI hand-rolled `rpcCall` plus a duplicate copy of every
   response type in `apps/web/src/lib/api.ts`. `@orpc/client`, `@orpc/contract`, `@orpc/react`,
   and `@orpc/tanstack-query` were installed but unused. `docs/architecture/api.md` states the
   contracts are the single source of truth for client types.

### P1 — required behavior with no runtime implementation

3. **No authentication.** The design has an `auth` namespace; the implementation hard-coded the
   audit actor to `webui-admin` and left every admin procedure open to anyone who could reach
   the port (mitigated only by the default `127.0.0.1` bind). `TSUKAIMA_WEB_ORIGIN` was parsed but
   never read, and there was no CORS handling.
4. **Persona and memory were not wired into the runtime.** `personas` and `memories` were only
   written by the migration package; the model call had no system prompt and no memory
   retrieval. Migrated memories and personas would land in the database and have no effect.
5. **Plugin tools and UI were dead pipes.** Plugins could register tools and UI, but the server
   never exposed plugin tools to the model and never consumed the UI registry. Only
   `message.received` was emitted of twelve declared hooks; the rest had no emission point.
6. **No realtime push.** The design promised streaming/live procedures; the WebUI polled with
   `refetchInterval` (3–10 s) and SSE carried only logs.
7. **No boundary validation.** `messageEnvelopeSchema` was never applied on the real ingest
   path (only inside the unwired chaos package).

### P2 — hygiene

8. Dead or unwired code: `@tsukaima/chaos` and `@tsukaima/coding` had no runtime importers,
   `UserService` in `apps/server/src/services/users.ts` was unused, and the tables `activities`,
   `activityMessages`, `memoryLinks`, and `pluginGrants` had zero references. Third-party worker
   plugins had no loader; the registry only installed built-ins.
9. `README.md` still claimed the scaffold "does not connect real models, NapCat, plugins, or the
   WebUI yet".
10. `apps/web/src/route-tree.gen.ts` (a generated file) was tracked while other generated output
    was ignored.
11. `admin/conversations/list` returned raw rows with no pagination, and `listChats` loaded the
    whole `messages` table to pick the latest row per session in memory.
12. `resolveIdentity` inserted the user before the identity and used `onConflictDoNothing`, so a
    race could return an orphan user and mis-attribute `messages.sender_user_id`.
13. No WebUI test coverage (Playwright was promised) and no server-level round-trip test, which
    is why finding 1 went unnoticed.

## Remediation

The P0 items were fixed first, in three disjoint workstreams:

| Workstream | Scope | Files |
| --- | --- | --- |
| Outbound reply loop | Durable answer observation, domain persistence, channel send, `after.reply`, idempotency | `packages/core/src/conversation-host.ts`, `apps/server/src/services/reply-dispatcher.ts`, `apps/server/src/services/webui.ts`, `apps/server/src/lifecycle.ts` |
| oRPC contracts | Contract definitions in `packages/contracts`, server handlers, typed WebUI client | `packages/contracts`, `apps/server/src/rpc`, `apps/web/src/lib/api.ts`, `apps/web/src/routes` |
| Boundary and hygiene | Envelope validation, identity race, dead code, unused tables, README, generated-file tracking | `apps/server/src/services/conversation-router.ts`, `packages/db`, `README.md`, `.gitignore` |

### Status after the first remediation round

Findings 1, 2, 7, 8, 9, 10, and 12 are resolved; finding 13 is partly resolved (a server-level
round-trip test and a boundary test now exist; there is still no WebUI test suite).

Verified on the integration tree:

- `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run --filter '@tsukaima/web' build` all pass.
- `bun test` → 150 tests across 31 files, 0 failures (was 145/29).
- A boot against a copy of the development domain database applied migration
  `0003_wise_darkhawk` in place (drops `activities`, `activity_messages`, `memory_links`,
  `plugin_grants`), reached `ready`, and served existing chats through the new contracts.
- `bun install` re-resolved the new `@orpc/contract` dependency of `packages/contracts` into
  `bun.lock`.

Outbound delivery is at-most-once: the outbound row is claimed through the
`(conversationId, durableEntryId)` unique index before the send, so a restart cannot replay an
answer. The cost is that a crash between the insert and the send leaves a permanent `pending`
row with no automatic retry.

### Open follow-ups

- A single inbound message is answered only when the activity window flushes, so one DM has
  roughly `policy.windowMs` (6 s) of added latency. Either lower the default window or add an
  immediate path for the first message of a window.
- `messages.activity_id` is now a dangling column: the tables that gave it meaning were dropped
  while the write remained.
- `remoteModelsInputSchema` and `runtimeSettingsPatchSchema` are declared both in
  `apps/server/src/remote-models.ts` / `runtime-settings.ts` and again in `packages/contracts`.
  One definition should move.
- Plugin tools are still not bridged to the model, `task.created`/`task.completed` have no
  emission point, and the WebUI still polls instead of subscribing.
- Admin authentication is hand-implemented rather than library-backed; see the open decision in
  `docs/architecture/api.md`.

### Second remediation round (persona/memory and authentication)

Findings 3 and 4 are resolved:

- Persona and memory are injected as pi-durable prompt sections (`tsukaima-persona`, `tsukaima-memory`)
  rendered per conversation from the domain database, with keyword retrieval, importance/recency
  ranking, a character budget, and a provider that degrades to `undefined` on any error.
- Admin authentication exists: `auth.status`/`login`/`logout`, an `adminBase` guard that rejects all
  25 admin procedures with `UNAUTHENTICATED` (asserted per path), argon2id credentials bootstrapped
  from the environment into `admin_credentials`, in-memory sessions with httpOnly cookies, login
  backoff, and a WebUI login route with root-level gating.

Hook coverage improved: `activity.opened`, `activity.closed`, and `before.reply` now have emission
points. Finding 5 is partly resolved; finding 6 (realtime) is untouched.

Integration verification for this round:

- `bun run check` → 166 tests across 34 files, 0 failures; `bun run --filter '@tsukaima/web' build` passes.
- A live server against a copy of the development database served `healthz` 200, `readyz` 204,
  rejected `admin/chats/list` with 401, accepted `auth/login`, then served the same call with 200
  using the session cookie, and rejected a wrong password with `UNAUTHENTICATED`.
- With no credential configured, the same call sequence reported `configured: false` and refused
  login, and the startup log named the missing variables.

## Method

Findings were confirmed by reading the code rather than by inference: the missing outbound call
was verified by grepping for every `emitDetached`/`hooks.emit` site and for readers of
`pi.assistant`; the unused tables and packages were verified by reference counting with `rg`;
the oRPC drift was verified by grepping the WebUI for `@orpc` imports (none).

Secrets, QQ content, and DSH session content are not recorded here.
