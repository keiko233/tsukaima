# API design

The WebUI and admin tools call Tsukaima through oRPC procedures mounted on Elysia. Zod schemas define every input and output. The contracts are the single source of truth for client types.

## API boundaries

| Namespace | Audience | Purpose |
| --- | --- | --- |
| `health` | Local monitoring | Process and dependency status |
| `auth` | Administrator | `auth.status`; login/logout/session routes are native Better Auth |
| `conversations` | Administrator | List, inspect, search, and manage conversations |
| `messages` | Administrator | Read history, send admin messages, inspect activities |
| `tasks` | Administrator | Inspect durable tasks and task graph |
| `users` | Administrator | Manage canonical users and aliases |
| `personas` | Administrator | Manage personas and bindings |
| `memories` | Administrator | Search, review, approve, edit, revoke memory |
| `models` | Administrator | Inspect model policies and usage |
| `plugins` | Administrator | Install, enable/disable, inspect, configure plugins |
| `policies` | Administrator | Manage conversation/global policies |
| `media` | Administrator | Browse, inspect, and delete media metadata |
| `audit` | Administrator | Review audit log |
| `migration` | Administrator/Migration Kit | Dry-run reports and import status |
| `coding` | Administrator | Inspect iteration tasks, approvals, diffs, and proposals |
| `pluginUi` | Plugin frontend bridge | Typed UI data/actions exposed by plugins |

Do not expose raw durable storage operations or arbitrary SQL through oRPC.

## Context

Every procedure receives an oRPC context. It is deliberately small: the server threads the
lifecycle handle (the composition root for domain services), the Better Auth facade, and the raw
request headers used to resolve the signed session cookie.

```ts
type ApiContext = {
  lifecycle: TsukaimaLifecycle;
  auth: AuthService;
  headers: Headers;
};
```

`admin/*` procedures are bound to `adminBase = apiBase.use(requireAdmin)`, which asks Better Auth to
validate the request session and rejects a request without one with `UNAUTHENTICATED` (HTTP 401)
before any handler runs. `health/status` and `auth/status` stay public. Domain services are reached
through `context.lifecycle` rather than being injected individually, so a new service does not
change the RPC context signature.

## Procedure conventions

1. Input and output schemas are Zod objects.
2. Prefer `list` procedures with cursor pagination.
3. Use stable error codes; do not expose raw stack traces.
4. Every mutation is audited.
5. Read procedures should be cheap and explicit about limits.
6. Streaming/live procedures are used for conversation updates and task progress.
7. Destructive procedures require explicit confirmation input where the UI cannot make intent clear.

## Error model

Use a small stable set:

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | Missing or invalid admin session |
| `FORBIDDEN` | Authenticated but not permitted |
| `NOT_FOUND` | Requested resource does not exist |
| `INVALID_INPUT` | Zod validation failed |
| `CONFLICT` | Version, unique key, or state conflict |
| `RATE_LIMITED` | Too many requests |
| `CHANNEL_UNAVAILABLE` | NapCat or channel is unavailable |
| `MODEL_UNAVAILABLE` | Model provider failure |
| `TASK_FAILED` | Durable task failed |
| `MIGRATION_BLOCKED` | Migration precondition failed |
| `INTERNAL` | Unexpected server error |

Every error includes a safe `message` and optional `details`.

## Health

```ts
health.status.query();
```

Returns:

```ts
{
  process: { uptimeMs: number; version: string; runtime: "bun" };
  databases: {
    durable: "ok" | "error";
    domain: "ok" | "error";
  };
  channels: Array<{
    id: string;
    kind: "onebot-v11" | "webui" | "fake";
    connected: boolean;
    lastEventAt?: string;
    lastError?: string;
  }>;
  models: {
    magpieReachable: boolean;
    policiesLoaded: number;
  };
  plugins: {
    loaded: number;
    enabled: number;
    failed: number;
  };
}
```

## Auth

Initial release has one administrator. Better Auth 1.7 is the authentication authority; Tsukaima does
not implement password hashing, token storage, or session validation itself.

Native Better Auth routes mounted on Elysia:

| Route | Purpose |
| --- | --- |
| `POST /api/auth/sign-in/username` | Username/password sign-in, signed cookie, DB session |
| `POST /api/auth/sign-out` | Revoke the current session and clear the cookie |
| `GET/POST /api/auth/get-session` | Session read and sliding refresh |

The only oRPC auth procedure is:

- `auth.status` → `{ authenticated, configured, username? }`. `configured: false` means no Better
  Auth user exists yet, so the WebUI shows setup guidance instead of a login form. The WebUI uses
  Better Auth's `get-session` as the runtime session authority and this procedure for setup
  guidance and API clients.

Behaviour:

- Bootstrap: on first start, if `auth_user` is empty, `TSUKAIMA_ADMIN_USERNAME` and
  `TSUKAIMA_ADMIN_PASSWORD` are passed to Better Auth's server-side `signUpEmail` API with the
  username plugin. The fixed account email comes from `TSUKAIMA_ADMIN_EMAIL` or
  `admin@tsukaima.invalid`. Afterwards the database row is authoritative; changing the environment
  does not rotate the password.
- Public sign-up is closed. The Elysia auth handler rejects every `/api/auth/sign-up/*` request; only
  the in-process bootstrap call can create the first account.
- Locked by default: with no stored user and no environment credential, every `admin/*` procedure
  rejects, `auth.status` reports `configured: false`, and the startup log names the missing
  variables. There is no "unconfigured means allow" path.
- Passwords are hashed and verified by Better Auth (scrypt by default). Sessions live in
  `auth_session` for 7 days and are refreshed once per day. A restart does not invalidate them.
- The cookie is `tsukaima.session_token`, `HttpOnly`, `SameSite=Lax`, and `Secure` when the public URL
  is HTTPS or `TSUKAIMA_AUTH_SECURE_COOKIES=true`.
- Sign-in is limited to 5 attempts per 60 seconds per client IP, with an in-process per-instance
  store. A direct Bun connection uses the socket peer address injected by the auth route; a
  spoofed `X-Forwarded-For` cannot change that bucket. Behind a reverse proxy, set
  `TSUKAIMA_TRUSTED_PROXIES` to the proxy IP/CIDR list so Better Auth may walk the forwarded chain
  from the right; unlisted proxies are never trusted.
- Browser origins are checked against `TSUKAIMA_PUBLIC_URL`, `TSUKAIMA_WEB_ORIGIN`, and the
  comma-separated `TSUKAIMA_TRUSTED_ORIGINS`. In non-production mode the Vite origins
  `http://127.0.0.1:7421` and `http://localhost:7421` are trusted by default; production requires
  an explicit list.
- Audit rows for successful sign-in, sign-out, and mutating admin actions carry
  `actorId = admin:<username>`. A denied sign-in uses `admin:unknown` because the native Better Auth
  boundary does not expose the attempted username without reading the request body twice; the
  payload still records the path and denial result.

### Audit actors

`TsukaimaLifecycle.writeAudit` accepts optional `actorId` and `actorKind` fields from the SDK's
`AuditEntry`. Better Auth's session hooks and the oRPC admin middleware supply the real administrator
actor where it is known; background services keep the default WebUI actor unless they have a more
specific identity.

## Realtime events

`GET /events/stream` is a server-sent event stream used by the WebUI shell. It is separate from
oRPC because `EventSource` cannot carry oRPC payloads; mutations stay on oRPC.

Authentication is mandatory. The endpoint passes the same Better Auth cookie to
`auth.api.getSession` and returns `401 UNAUTHENTICATED` without a live session; no stream is opened.
`GET /events/logs` is guarded the same way.

Events (`event:` name equals the payload's `type`):

| Event | Payload |
| --- | --- |
| `snapshot` | `{ timestamp, lifecycle: { state, stage, startedAtMs, reason? }, processedMessages }` |
| `heartbeat` | `{ timestamp }` |
| `message.received` | `{ timestamp, channelId, chatObjectId, sessionId, messageId }` |
| `activity.opened` / `activity.closed` | `{ timestamp, activityId, conversationId, envelopeCount }` |
| `before.reply` | `{ timestamp, channelId \| null, chatObjectId, sessionId, entryId, text }` |
| `after.reply` | Same as `before.reply` plus `deliveryStatus` |
| `run.state` | `{ timestamp, sessionId, run: LiveRunState \| null }` |
| `run.delta` | `{ timestamp, sessionId, revision, patch: LiveRunPatch }` |

Contract: `liveEventSchema` in `packages/contracts`. The WebUI validates every frame and only then
invalidates the affected TanStack Query keys.

Operational properties:

- A fresh `snapshot` is sent on every (re)connection, so a reconnecting client re-queries everything
  it missed. There is no `Last-Event-ID` replay; event-level compensation is not implemented.
- A heartbeat is sent every 15 seconds by default. The WebUI uses it as a low-frequency resync for
  data with no host hook yet (OneBot connection state, friend/group requests).
- Each stream is bounded: a subscriber that stops reading is closed rather than buffered.
- The stream is authorised at connect time; a logout invalidates new connections but does not tear
  down an already-open stream. Re-validating the session on heartbeat is a planned hardening step.

## Conversations

Core procedures:

```ts
conversations.list.query({
  cursor?: string;
  limit?: number;
  kind?: "private" | "group" | "webui" | "task" | "plugin";
  channelId?: string;
  search?: string;
  status?: "active" | "archived" | "hidden";
});

conversations.get.query({ conversationId: string });

conversations.summary.query({
  conversationId: string;
  includeActivity?: boolean;
  includeMembers?: boolean;
});

conversations.update.mutation({
  conversationId: string;
  title?: string;
  status?: "active" | "archived" | "hidden";
});

conversations.purge.mutation({
  conversationId: string;
  confirmation: string;
  backup: boolean;
});
```

`conversations.list` joins domain metadata with a bounded durable summary. It must not scan full durable history.

## Messages and activities

```ts
messages.list.query({
  conversationId: string;
  cursor?: string;
  limit?: number;
  order?: "ascending" | "descending";
  includeRaw?: boolean;
});

messages.get.query({ messageId: string });

messages.send.mutation({
  conversationId: string;
  parts: MessagePartInput[];
  options?: {
    requireApproval?: boolean;
    dryRun?: boolean;
  };
});

messages.activity.get.query({ activityId: string });
messages.activity.list.query({ conversationId: string; cursor?: string; limit?: number });
```

For live updates the WebUI subscribes to the server-sent event stream described under
[Realtime events](#realtime-events). Assistant streaming is carried by `run.state` and
`run.delta`: text, reasoning, draft tool calls, and the accumulated model/tool call chain are
applied to a dedicated per-session store instead of invalidating the transcript on every token.
Delivery and lifecycle transitions still re-query the affected procedures.

## Tasks

```ts
tasks.graph.query();
tasks.get.query({ taskId: string });
tasks.list.query({
  conversationId?: string;
  status?: string;
  kind?: string;
  cursor?: string;
  limit?: number;
});
tasks.abort.mutation({ taskId: string; reason: string });
```

`tasks.graph` wraps the durable task graph view. The WebUI renders subagent and background task ownership.

## Users

```ts
users.list.query({ search?: string; cursor?: string; limit?: number });
users.get.query({ userId: string });
users.update.mutation({
  userId: string;
  displayName?: string;
  preferredName?: string;
  trustLevel?: "normal" | "trusted" | "restricted" | "blocked";
  notes?: string;
});

users.aliases.add.mutation({ userId: string; alias: string; source: string });
users.aliases.remove.mutation({ aliasId: string });
users.merge.mutation({
  sourceUserId: string;
  targetUserId: string;
  confirmation: string;
});
```

User merge must preserve memory, audit, and message references. It is a rare administrative action.

## Personas

```ts
personas.list.query();
personas.get.query({ personaId: string; version?: number });
personas.create.mutation({
  name: string;
  summary: string;
  prompt: PersonaPromptInput;
  behavior: PersonaBehaviorInput;
});

personas.update.mutation({
  personaId: string;
  expectedVersion: number;
  patch: Partial<PersonaPromptInput & PersonaBehaviorInput>;
});

personas.activate.mutation({ personaId: string; version: number });
personas.bind.mutation({
  personaId: string;
  conversationId?: string;
  active: boolean;
});
```

Personas are immutable versions. Updates create a new version.

## Memories

```ts
memories.search.query({
  query: string;
  scope?: MemoryScope;
  userId?: string;
  conversationId?: string;
  limit?: number;
});

memories.list.query({
  scope?: MemoryScope;
  userId?: string;
  conversationId?: string;
  status?: "active" | "expired" | "revoked";
  cursor?: string;
  limit?: number;
});

memories.get.query({ memoryId: string });
memories.create.mutation({ scope, subjectUserId?, conversationId?, content, summary, kind, visibility });
memories.update.mutation({ memoryId: string; patch });
memories.revoke.mutation({ memoryId: string; reason: string });
memories.restore.mutation({ memoryId: string });
```

Memory procedures are admin-only. Agent memory operations go through internal service APIs, not public oRPC.

## Models

```ts
models.policies.list.query();
models.policies.get.query({ capability: string });
models.policies.update.mutation({ capability: string; patch: ModelPolicyPatch });
models.providers.list.query();
models.usage.summary.query({ range: "day" | "week" | "month" });
models.usage.byConversation.query({ conversationId: string });
```

Model credentials are never returned.

## Plugins

```ts
plugins.list.query();
plugins.get.query({ pluginId: string });
plugins.manifest.query({ pluginId: string });
plugins.config.get.query({ pluginId: string });
plugins.config.update.mutation({ pluginId: string; config: unknown });
plugins.enable.mutation({ pluginId: string; runMode?: "host" | "worker" });
plugins.disable.mutation({ pluginId: string });
plugins.permissions.update.mutation({
  pluginId: string;
  grants: Array<{ permission: string; granted: boolean }>;
});
```

Plugin installation may be deferred until the plugin SDK is stable. The API shape should exist from the start.

## Policies

```ts
policies.global.get.query();
policies.global.update.mutation({ patch: PolicyPatch });
policies.conversation.get.query({ conversationId: string });
policies.conversation.update.mutation({ conversationId: string; patch: PolicyPatch });
```

Policy patch validation is schema-driven. Unknown fields are rejected.

## Media

```ts
media.list.query({
  kind?: MediaKind;
  conversationId?: string;
  search?: string;
  cursor?: string;
  limit?: number;
});

media.get.query({ mediaId: string });
media.delete.mutation({
  mediaId: string;
  confirmation: string;
  deleteBlob: boolean;
});
```

Media blobs are referenced by content hash. Deletion must refuse when live references remain unless `force` is added explicitly.

## Audit

```ts
audit.list.query({
  actorKind?: string;
  action?: string;
  targetKind?: string;
  targetId?: string;
  cursor?: string;
  limit?: number;
});
```

Audit records are append-only.

## Migration

```ts
migration.runs.list.query();
migration.runs.get.query({ migrationRunId: string });
migration.records.list.query({
  migrationRunId?: string;
  sourceSystem?: string;
  status?: string;
  cursor?: string;
  limit?: number;
});
migration.report.get.query({ migrationRunId: string });
```

The Migration Kit CLI writes directly to the migration tables. The WebUI is read-only during phase 6.

## Coding

```ts
coding.tasks.list.query();
coding.tasks.get.query({ taskId: string });
coding.tasks.diff.query({ taskId: string });
coding.tasks.tests.query({ taskId: string });
coding.proposals.list.query();
coding.proposals.get.query({ proposalId: string });
coding.proposals.approve.mutation({ proposalId: string; confirmation: string; notes?: string });
coding.proposals.reject.mutation({ proposalId: string; reason: string });
```

Deployment remains outside oRPC until a host-side deployer exists. oRPC only exposes proposal state.

## WebUI flows

### Conversation view

1. Fetch conversation metadata and policy.
2. Fetch recent messages with cursor pagination.
3. Subscribe to `/events/stream` (see [Realtime events](#realtime-events)).
4. Render raw messages, aggregated activities, assistant turns, tool cards, and outbound actions.
5. Admin actions are separate buttons with confirmation.

### Task view

1. Fetch task graph.
2. Subscribe to task updates.
3. Render durable task status and child ownership.
4. Expose abort with reason.

### Memory review

1. Search/list memories.
2. Inspect source conversation/activity.
3. Edit, revoke, or restore with audit.

### Plugin admin

1. Fetch plugin registry.
2. Render manifest, permissions, config schema, and status.
3. Update config through schema-validated form.

### Migration report

1. Fetch migration runs.
2. Render counts, warnings, and unresolved mappings.
3. Link to source conversations and imported targets.

## Versioning

Start with a single API surface. If a breaking contract change is unavoidable:

1. Prefer additive changes.
2. Add a new procedure instead of changing existing semantics.
3. Keep old procedures until all clients migrate.
4. Record breaking changes in ADRs and changelog.
