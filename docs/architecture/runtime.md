# Runtime and persistence

## Process model

- `tsukaima-server`: Bun process containing HTTP API, WebSocket gateway for WebUI, channel runtime, agent runner, and scheduler.
- `plugin-worker`: Bun worker/subprocess for selected third-party or long-running plugins.
- `coding-runner`: subprocess or sandboxed environment for self-iteration jobs.
- `migration-kit`: Bun CLI used before and during cutover.

All persistent reads and writes go through storage services; workers do not share mutable SQLite handles except through the host API.

## pi-durable usage

A durable **Conversation** represents a stable logical chat or task context. Each conversation has immutable entries and documents.

Mapping:

| Bot concept | Durable representation |
| --- | --- |
| QQ private chat | One conversation keyed by channel + peer identity |
| QQ group | One conversation keyed by channel + group identity |
| WebUI admin chat | One or more administrator conversations |
| Plugin background task | Task-owned child conversation where needed |
| Coding run | Task-owned child conversation with coding tools |
| Proactive campaign | Background task plus target conversation references |

`pi-durable` provides:

- Atomic commits of entries, documents, and tasks.
- Durable generation/tool tasks with restart recovery.
- Busy handling with `steer` and `follow-up` placement.
- Compaction.
- Per-conversation agent configuration.
- Watchable views for WebUI.

Conversations are never reused for different logical chats. A conversation reset is allowed only as a user-visible action and preserves raw history.

## SQLite adapter

The first implementation adds a Bun adapter:

- `BunSqliteDatabase` implements the portable `SqliteDatabase` interface used by `pi-durable`.
- It wraps `bun:sqlite`.
- It provides `exec`, `run`, `runCounted`, `get`, `all`, `transaction`, and `close`.
- It serializes operations, configures WAL and normal synchronous mode, and uses an explicit busy timeout.
- `SqliteStorage.open(bunDb, { prefix })` creates the durable storage.

The adapter is conformance-tested against a fake model and fake channel before production use. If upstream Pi later ships a supported Bun SQLite adapter, this local adapter is replaced.

## Domain database

Domain data uses SQLite with Drizzle ORM in a separate database file from durable conversation storage:

- identities and aliases
- user/profile/relationship facts
- memory records and embeddings/index metadata
- personas and persona versions
- plugins and manifests
- policy, audit, deployment, and migration records
- media index

Durable chat entries remain in `durable.sqlite`. Domain records that are useful outside one chat (people, facts, plugin registry, audit) live in `domain.sqlite`. IDs reference, but do not duplicate, durable conversation/entry IDs. Ephemeral TTL state, live-run snapshots, and plugin caches live in `cache.sqlite` and are never the source of truth; see [KV cache](kv-cache.md).

The domain database uses:

- `drizzle-orm` with the Bun SQLite driver
- `drizzle-kit` migrations
- typed query builders and transaction helpers
- explicit foreign keys to canonical IDs and source IDs

Do not join across databases in SQL. Resolve cross-database references in application services.

## Media storage

- Original attachments are stored in a content-addressed blob directory.
- SQLite stores SHA-256, MIME type, size, dimensions/duration where available, source URL, and expiry metadata.
- QQ media is downloaded through controlled channel APIs, not raw guessed URLs.
- Never embed large blobs in SQLite.

## Failure behavior

- Channel receives are acknowledged only after durable ingestion.
- Provider errors leave the submission failed and recoverable; do not silently drop user messages.
- Plugin errors are isolated and reported in WebUI.
- Storage failure is fatal to the server process; the process restarts and resumes durable work.

Database migration is part of application startup. See [startup-lifecycle.md](startup-lifecycle.md).
