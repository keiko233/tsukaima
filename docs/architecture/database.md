# Database design

Elaina has two SQLite databases with separate ownership and migration paths:

1. `durable.sqlite` — owned by `pi-durable`.
2. `domain.sqlite` — owned by Drizzle and application services.

They may live in the same data directory but must not be accessed as one database. No SQL joins cross the boundary. Cross-database references are resolved in domain services.

## File layout

```text
data/
  durable.sqlite
  durable.sqlite-wal
  durable.sqlite-shm
  domain.sqlite
  domain.sqlite-wal
  domain.sqlite-shm
  blobs/
    <first two sha256 bytes>/<full sha256>
```

`blobs/` stores attachments and imported media. File names are content hashes. Metadata lives in `domain.sqlite`.

## Durable database

`durable.sqlite` is created and migrated by `pi-durable`. Application code must not alter its schema directly.

It contains, conceptually:

- conversations
- immutable conversation entries
- tasks and task state
- submissions and queues
- documents
- document revisions
- usage records
- compaction state

Expected durable documents added by Elaina:

| Document kind         | Scope        | Purpose                                                               |
| --------------------- | ------------ | --------------------------------------------------------------------- |
| `elaina.chat.meta`    | conversation | Canonical conversation ID, display name, channel source, policy hints |
| `elaina.chat.policy`  | conversation | Response mode, quiet hours, rate limits, tool policy                  |
| `elaina.activity`     | conversation | Aggregated message activity and member envelope IDs                   |
| `elaina.channel.send` | conversation | Outbound action records and delivery state                            |
| `elaina.media`        | conversation | References to blob hashes and canonical media IDs                     |
| `elaina.plugin.state` | conversation | Plugin-owned conversation state                                       |
| `elaina.iteration`    | conversation | Coding task metadata and approval state                               |

The exact serialization shape is defined in implementation. Every document must be versioned.

## Domain database tables

The tables below are the design target. Drizzle schema should match these concepts even if implementation names adjust slightly.

### meta

Schema version and singleton state.

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### admin_credentials

The single WebUI administrator. Exactly one row is expected; the database row is authoritative over
the bootstrap environment variables.

```sql
CREATE TABLE admin_credentials (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,   -- Bun.password argon2id
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Admin sessions are intentionally not stored here: they live in process memory, so a restart signs
the administrator out and no session token ever reaches disk.

### identities

One row per platform identity.

```sql
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL,
  platform_account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group', 'system')),
  display_name TEXT,
  raw_metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, platform_account_id, external_id, kind)
);
```

For QQ:

- `platform = 'onebot-v11'`
- `platform_account_id` is the bot account ID.
- `external_id` is the QQ user ID or group ID.

### users

Canonical bot-layer user.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'bot', 'system')),
  display_name TEXT,
  preferred_name TEXT,
  trust_level TEXT NOT NULL DEFAULT 'normal',
  is_admin INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### user_aliases

Names the same canonical user may use.

```sql
CREATE TABLE user_aliases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, alias)
);
```

### chat_objects

Stable communication scope. A chat object can contain many Elaina sessions. External
objects are scoped by channel and platform conversation ID; local WebUI chat objects
have no external identifiers.

```sql
CREATE TABLE chat_objects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('private', 'group', 'webui', 'task', 'plugin')),
  channel_id TEXT,
  platform_conversation_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, kind, platform_conversation_id)
);
```

### conversations

Domain-side metadata for one Elaina session and its durable conversation. `conversations`
is retained as the session table so existing durable IDs remain stable.

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  chat_object_id TEXT NOT NULL REFERENCES chat_objects(id) ON DELETE CASCADE,
  durable_conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('private', 'group', 'webui', 'task', 'plugin')),
  channel_id TEXT,
  platform_conversation_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_receiving INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX conversations_one_receiving_unique
  ON conversations (chat_object_id)
  WHERE is_receiving = 1;
```

At most one active session per external chat object is designated as the receiving
session for new external messages. A new session does not imply a new external chat.
Changing the receiving session does not move prior messages.

`task` and `plugin` sessions may have no `channel_id`.

### conversation_members

Participants in a conversation. Group membership is not automatically inferred for every message sender; add rows when known.

```sql
CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin', 'bot', 'observer')),
  platform_role TEXT,
  joined_at TEXT,
  last_seen_at TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
```

### messages

Canonical message index. Raw durable conversation history remains in durable SQLite.

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_object_id TEXT NOT NULL REFERENCES chat_objects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  durable_entry_id TEXT,
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  platform_message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'system')),
  kind TEXT NOT NULL,
  content_text TEXT,
  parts_json TEXT,
  sender_display_name TEXT,
  sender_external_id TEXT,
  reply_to_message_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'received'
    CHECK (delivery_status IN ('received', 'pending', 'accepted', 'sent', 'failed', 'uncertain')),
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_aggregated INTEGER NOT NULL DEFAULT 0,
  activity_id TEXT,
  raw_ref_json TEXT,
  UNIQUE (chat_object_id, platform_message_id)
);
```

`platform_message_id` may be null for system-generated messages. The unique index is partial in Drizzle where possible.

Durability is two-phase in practice: the durable message receipt and activity admission
are committed together, then the domain message row is indexed. A duplicate at either
layer returns the existing message instead of appending another turn.

### requests

Friend, group join, and group invitation events. Requests are not model turns.

```sql
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  flag TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('friend', 'group-add', 'group-invite')),
  sub_type TEXT,
  requester_external_id TEXT NOT NULL,
  requester_display_name TEXT,
  group_external_id TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'failed', 'uncertain')),
  resolution_action TEXT CHECK (resolution_action IN ('approve', 'reject')),
  resolution_reason TEXT,
  error_message TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (channel_id, flag)
);
```

`flag` is preserved for OneBot correlation. Before a remote decision is attempted, the
row moves to `uncertain`; that makes a crash during the request identify the outcome as
unknown rather than inviting a duplicate retry.

### Activity state lives in the durable database

There are no `activities` or `activity_messages` tables. Activity windows and message receipts are
durable documents (`elaina.activityWindow`, `elaina.messageReceipt`) scoped to the conversation,
because they must be replayed and recovered with the conversation itself. The domain database keeps
only `messages.activity_id`, the durable activity a message was aggregated into, for display and
correlation.

### personas

Versioned persona records.

```sql
CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  behavior_json TEXT NOT NULL,
  model_policy_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE (id, version)
);
```

### persona_bindings

Which persona applies globally or to a conversation.

```sql
CREATE TABLE persona_bindings (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK (
    (conversation_id IS NULL AND is_global = 1) OR
    (conversation_id IS NOT NULL AND is_global = 0)
  )
);
```

`is_global` is a generated or explicit boolean column; define it clearly in Drizzle.

### model_policies

Capability-level model routing records.

```sql
CREATE TABLE model_policies (
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  primary_provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  fallbacks_json TEXT NOT NULL,
  thinking_level TEXT,
  max_output_tokens INTEGER,
  daily_budget_usd REAL,
  allowed_tools_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (capability)
);
```

### memories

Scoped memory records.

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'persona', 'user', 'conversation', 'project', 'ephemeral')),
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  project_id TEXT,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  importance REAL NOT NULL DEFAULT 0.5,
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_entry_id TEXT,
  source_activity_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'user', 'migration', 'system'))
);
```

See `memory.md` for retrieval policy.

Memories reference their entities directly (`subject_user_id`, `conversation_id`, `project_id`,
scope) rather than through a link table; retrieval queries those columns through
`memories_scope_idx`.

### plugins

Installed plugin registry.

```sql
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'first-party', 'third-party')),
  manifest_json TEXT NOT NULL,
  config_schema_json TEXT,
  config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  run_mode TEXT NOT NULL CHECK (run_mode IN ('host', 'worker')),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

There is no `plugin_grants` table. A plugin's grants are the permissions declared in its manifest
and installed into the in-process registry; the registry rejects a grant that the manifest does not
declare, so a separate grant table would only duplicate that check. Persisting per-plugin grants is
revisited when third-party plugins can be installed and enabled independently.

### policies

Conversation and global policies.

```sql
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'conversation', 'plugin', 'model', 'coding')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  policy_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### audit_log

Append-only administrative and safety-sensitive events.

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'plugin', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
  reason TEXT,
  payload_json TEXT
);
```

### media

Content-addressed attachments.

```sql
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'sticker', 'audio', 'video', 'file')),
  source TEXT NOT NULL CHECK (source IN ('onebot', 'webui', 'migration', 'generated')),
  source_url TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  metadata_json TEXT
);
```

### migration_records

Idempotent import ledger.

```sql
CREATE TABLE migration_records (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'imported', 'skipped', 'failed', 'rolled_back')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_system, source_id, target_kind)
);
```

### migration_runs

One migration execution.

```sql
CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('dry_run', 'running', 'completed', 'failed', 'rolled_back')),
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'import')),
  report_json TEXT
);
```

## Drizzle rules

1. Use `drizzle-orm/bun-sqlite`.
2. Use string IDs generated by domain services, typically ULID or UUIDv7.
3. Store timestamps as ISO-8601 UTC strings for portability.
4. Store JSON as text and validate with Zod before writing.
5. Every mutable table has `created_at`; most have `updated_at`.
6. Use `ON DELETE CASCADE` only for true child records.
7. Use `ON DELETE RESTRICT` for referenced records that should not disappear silently.
8. Use `ON DELETE SET NULL` only where losing the reference is acceptable.
9. Add indexes for every actual query path; do not add speculative indexes.

Recommended initial indexes:

```sql
CREATE INDEX identities_canonical_idx ON identities(canonical_user_id);
CREATE INDEX conversations_channel_idx ON conversations(channel_id, kind, status);
CREATE INDEX messages_conversation_time_idx ON messages(conversation_id, occurred_at DESC);
CREATE INDEX messages_sender_idx ON messages(sender_user_id);
CREATE INDEX activities_conversation_idx ON activities(conversation_id, opened_at DESC);
CREATE INDEX memories_scope_idx ON memories(scope, subject_user_id, conversation_id, updated_at DESC);
CREATE INDEX memories_content_idx ON memories(summary);
CREATE INDEX plugins_enabled_idx ON plugins(enabled, kind);
CREATE INDEX audit_time_idx ON audit_log(occurred_at DESC);
CREATE INDEX media_sha_idx ON media(sha256);
CREATE INDEX migration_source_idx ON migration_records(source_system, source_id);
```

## Migration policy

- Use `drizzle-kit` for schema migrations.
- Every schema change gets a migration file.
- Do not edit an applied migration.
- Add seed migrations only for non-secret configuration, not user data.
- Before destructive migrations, create a database backup.
- Migration ledger records are not deletable except through the explicit rollback workflow.
- The application startup path runs domain migrations automatically before the server becomes ready.
- Durable migrations run when `pi-durable` storage is opened during startup.
- A migration failure fails startup and prevents traffic.
- Use a startup lock to prevent two instances from migrating simultaneously.
- Destructive migrations require a backup and an explicit maintenance-mode confirmation unless marked safe.

See [startup-lifecycle.md](startup-lifecycle.md) for the exact boot order.

## Transaction rules

1. Domain service functions that touch more than one table should accept an existing transaction or create one internally.
2. Never update `domain.sqlite` and `durable.sqlite` in one SQL transaction.
3. If both databases must change, define which one is the source of truth and recover the other from a retryable action.
4. Durable conversation writes must use `pi-durable` APIs.
5. Cross-database references are eventual and must be reconcilable from IDs.
