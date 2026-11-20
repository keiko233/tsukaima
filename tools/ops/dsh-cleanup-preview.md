# DSH cleanup preview

`bun tools/ops/dsh-cleanup-preview.ts --db <domain.sqlite> [--now <ISO>]` opens the domain
database read-only and prints an aggregate-only JSON report. It never prints row IDs, source
paths, conversation titles, memory text, user identifiers, or file contents, and it performs no
cleanup. `--now` exists for deterministic audits of future timestamps.

## Provenance joins

The import ledger is the authoritative provenance source. Imported records are joined by
`migration_records.target_id`, never by a `dsh_` ID convention alone:

- messages: `messages.id = migration_records.target_id` where `target_kind = 'messages'`
- conversations: `conversations.id = migration_records.target_id` where
  `target_kind = 'conversations'`
- memories: `memories.id = migration_records.target_id` where `target_kind = 'memories'`
- chat objects: `chat_objects.id = migration_records.target_id` where
  `target_kind = 'chatObjects'`

All joins require `source_system = 'dsh'` and `status = 'imported'`. Message provenance also
checks `raw_ref_json` for its source hash. Orphaned ledger targets are reported separately so a
cleanup is not based on a broken mapping.

## Candidate matrix

| Area | Automatic candidate | Semantic review |
| --- | --- | --- |
| Timestamps | Exact epoch fallback (`1970-01-01T00:00:00Z`) can be marked unknown. | Any other pre-2000, invalid, or future timestamp; source time cannot be reconstructed safely. |
| Tool traces | Imported `kind = 'tool'` rows in `webui`, `workspace`, or `task` conversations, unreferenced by a reply or memory. Hide or delete only after the report is reviewed. | Referenced traces and every OneBot/group/private trace. |
| Shared memories | Active imported global rows with hard credential-like content can be quarantined. Pending imported globals are already inert. | Noisy long logs, paths, URLs, code, or ambiguous content; relevance requires semantic review. |
| Summaries | Unpinned redundant rows in an exact duplicate group, keeping the pinned/oldest deterministic row. | Pinned duplicates, near duplicates that differ by case or punctuation, and summaries without a conversation. |
| Test sessions | Explicitly named test WebUI sessions with no user messages can be archived. | Any test session with user messages; conversation deletion is never automatic. |

Automatic means a deterministic, reversible or non-destructive action is possible. It does not
authorize deleting human conversation content. Exact duplicates and hard unsafe signals are the
only content-level automatic candidates; everything else stays behind review.

## Interpretation

- A pre-2000 memory timestamp usually means a missing source field was normalized to the epoch
  fallback, not that the memory is genuinely from that date.
- Imported tool calls and results are execution transcript, not visible chat. Referenced traces
  must be preserved because a reply or memory still points at them.
- Global imported memories are shared across conversations. Treat pending rows as quarantined,
  not merely unapproved; active rows need a safety and relevance decision.
- Imported summaries may include both source summaries and one migration-generated
  conversation summary, so exact duplicates are safe cleanup candidates while near duplicates
  are not.
- Test-session detection deliberately uses explicit `test` path/title markers. Generic workspace
  sessions are not test sessions.

## Applying verified repairs to a copy

Run `bun tools/ops/dsh-repair-copy.ts --apply-to-copy <staged-domain.sqlite>` after the main
database cleanup, while the copy is isolated. The repair uses the ledger and stored compactor
evidence to identify summary timestamps that equal a text offset. It uses the last imported
message's timestamp for that conversation. It also moves unapproved epoch-dated NapCat
cross-session snippets to pending review and revokes unpinned byte-identical summary duplicates.
Rows and ledger entries remain available for review. The tool records one audit entry for the
transaction and checks integrity and WAL state before the copy can be promoted.
