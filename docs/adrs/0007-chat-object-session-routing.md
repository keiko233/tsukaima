# ADR 0007: Separate chat objects from sessions and use one receiving session

## Status

Accepted.

## Context

The existing `conversations` table represented both the external communication scope and the durable Elaina context. A unique `(channel_id, platform_conversation_id)` index therefore prevented one external chat from owning more than one Elaina session.

The WebUI design requires a stable chat object that can contain multiple sessions. Incoming external messages also need deterministic ownership without silently moving history when a different session is selected in the browser.

## Decision

- `chat_objects` is the stable communication scope. External chat objects are identified by channel, kind, and platform conversation ID. Local WebUI chat objects have no external ID.
- Existing and new `conversations` rows are Elaina sessions. A session owns one durable conversation and one message context.
- Each external chat object has at most one active receiving session, enforced by a partial unique index on `is_receiving = 1`.
- Incoming external messages always route to the current receiving session. Selecting a different session in the UI does not change routing.
- Changing the receiving session is explicit and affects only subsequent messages. Previous messages stay in the session where they were ingested.
- A receiving session cannot be archived until another active session is designated as receiving.
- Incoming message deduplication is enforced at two levels: the durable message receipt is committed atomically with activity admission, and the domain message table is unique by `(chat_object_id, platform_message_id)`.
- Request events are persisted separately from conversation turns. They never enter model context automatically.
- A collecting activity window is flushed after the configured inactivity period and recovered after restart.

## Migration

Migration `0002_redundant_corsair.sql` creates `chat_objects`, backfills one chat object per existing conversation, assigns the existing conversation as the receiving session, and backfills message ownership. Durable conversation IDs are not changed.

## Consequences

- Creating, renaming, archiving, or changing a session never creates, renames, or deletes an external chat.
- A crash after durable admission but before domain indexing can be replayed without creating a second durable message.
- Concurrent duplicate events in one server process coalesce through the ingestion lock; the database indexes remain the final protection.
- The receiving session is a product rule, not a OneBot capability. A future automatic-routing policy would require a new explicit decision.
- Request timeouts remain `uncertain` rather than `failed`, and the UI does not invite an unsafe automatic retry.
