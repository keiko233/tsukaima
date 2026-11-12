# ADR 0002: Use pi-durable over SQLite with a Bun adapter

## Status

Accepted

## Context

Bot chats require durable history, steering, background tasks, crash recovery, compaction, and watchable state. Pi's durable layer provides these primitives but its current Node SQLite adapter depends on `node:sqlite`, which is not the primary Bun SQLite driver.

## Decision

Adopt `pi-durable` as the conversation/task core and implement a local `BunSqliteStorage` adapter implementing its portable `SqliteDatabase` interface.

## Conformance requirements

The adapter must pass:

- schema migration smoke tests
- transaction rollback tests
- concurrent read/write serialization tests
- WAL recovery checks
- fake-model conversation/task examples
- fake-channel restart and steer tests

## Consequences

- No fork of `pi-durable` logic is required.
- The adapter is isolated and replaceable.
- Upstream changes require version pinning and conformance testing.
- Chat history remains in SQLite; domain-wide data belongs in PostgreSQL.
