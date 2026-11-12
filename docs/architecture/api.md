# API design

The WebUI and admin tools call Elaina through oRPC procedures mounted on Elysia. Zod schemas define every input and output. The contracts are the single source of truth for client types.

## API boundaries

| Namespace | Audience | Purpose |
| --- | --- | --- |
| `health` | Local monitoring | Process and dependency status |
| `auth` | Administrator | Session login/logout/status |
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

Every procedure receives an oRPC context:

```ts
type ApiContext = {
  requestId: string;
  auth: {
    isAuthenticated: boolean;
    userId?: string;
    roles: string[];
  };
  db: DomainDb;
  durable: DurableHost;
  services: {
    conversations: ConversationService;
    users: UserService;
    memory: MemoryService;
    personas: PersonaService;
    plugins: PluginRegistry;
    models: ModelRouter;
    onebot?: OneBotService;
    coding?: CodingService;
    migration?: MigrationService;
  };
  audit: AuditLogger;
};
```

The server creates the base context per request. Procedures may narrow it with guards.

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

Initial release has one administrator.

Procedures:

- `auth.status.query()`
- `auth.login.mutation({ username, password })`
- `auth.logout.mutation()`
- `auth.session.query()`

Sessions are cookie-based and stored through Better Auth. Password or credential storage must not be implemented in application code unless a suitable provider is unavailable.

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

For live updates:

```ts
messages.stream.live({
  conversationId: string;
});
```

The stream emits durable view changes, including assistant streaming state, tool calls, and outbound delivery status.

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
3. Subscribe to `messages.stream.live`.
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
