# DSH migration compatibility spec

## Outcome

The migration kit can snapshot, inspect, dry-run, import, verify, and roll back the actual DSH
deployment without leaking secrets or mutating the source.

## Current boundary

The kit supports inspect/normalize/dry-run/import/verify/rollback, but its parser assumes plain
JSONL/JSON fixtures. It does not understand actual zstd v4 session records, DSH plugin
settings, NapCat memory profiles, or meme pack index databases.

## Scope

In scope:

1. DSH home/workspace volumes
2. session v4 zstd JSONL
3. plugin/profile manifests and effective config
4. NapCat plugin settings
5. personas/agent presets
6. Mnemon memory, documents, spaces
7. NapCat shared/cross memory and human profiles
8. meme packs
9. schedule storage
10. friend/group request ledgers
11. settings that map to Tsukaima policy
12. referenced media

Out of scope:

- DSH browser profile
- Chrome cache/cookies/sessions
- npm/pnpm caches
- logs except required diagnostics
- secret values
- DSH plugin executable behavior

## Snapshot CLI

Add `snapshot` to `tools/migration/src/cli.ts` alongside the existing `inspect`, `normalize`,
`dry-run`, `import`, `verify`, and `rollback` commands:

`migration snapshot --host <user@host> --project <dir> --output <dir>` (supporting the current
audit target via flags/env rather than hardcoded host literals):

1. verify SSH and Docker access
2. stop nothing; copy read-only
3. mount volumes read-only
4. stream into local tar/zstd
5. create `manifest.json`, `files.jsonl`, and `errors.jsonl`
6. record path, size, sha256, mode, ownership class
7. classify sensitive files
8. redact tokens/keys/credentials from selected structured text
9. exclude caches/browser profile/secrets by default

Every path/value record is classed using the DSH baseline spec.

## Session v4 parser

Implement schema version detection:

1. decompress with a streaming zstd reader
2. parse NDJSON incrementally
3. detect event/entry/message roles/types/timestamps/content/attachments/tool calls
4. preserve unknown fields in source envelope
5. build users, chat objects, sessions, messages, attachments, references
6. map workspace-only and test sessions to admin/test conversations
7. map napcat group/private IDs to Tsukaima chat objects

Large streams are bounded, resumable, and report malformed/missing/unsupported records without
dropping valid ones.

## Config mapper

`config.yaml` maps source settings to target classes; unknown settings land in review. Mapping
groups:

| DSH area | Tsukaima target |
| --- | --- |
| provider/model | plugin model catalog/policy |
| NapCat transport/access | NapCat plugin config/policy |
| trigger/pacing/burst | conversation policy |
| persona/persona overrides | persona bindings |
| memory spaces/recent/cross/shared | memory plugin config/import |
| meme packs/dirs | sticker plugin import |
| search providers | search plugin config |
| compaction/retention | memory/context policy |
| schedule/proactive | scheduler plugin config |
| admin/danger permissions | admin/policy settings |

No URL/token/key/credential values are imported. Write a decision report with direct, remap,
review, and discard classifications.

## Memory and profile importer

1. parse Mnemon spaces/items/documents without executing providers
2. map to Tsukaima memory scopes/kinds
3. import archive/recent/shared/cross data with provenance
4. map human-profile counters to scheduler operational state
5. preserve timestamps and confidence
6. classify unresolved structures as review items

## Sticker importer

1. parse DSH meme pack manifests/index DBs
2. copy only referenced media into migration media store
3. map tags/emotions/keywords
4. deduplicate by SHA-256
5. preserve pack IDs/source provenance
6. import packs disabled until verified

## Schedule/request importer

1. parse schedule storage fields
2. map to durable scheduled tasks
3. skip expired tasks by policy
4. preserve prompt/status/timestamps
5. map friend/group request ledger to request rows or archived decisions
6. never replay requests without explicit approval

## Dry run and import

Dry-run reports:

- source counts by kind
- mapped/unmapped/discarded settings
- users/chats/messages/memory/media/settings
- schema warnings
- malformed/unsupported records
- media missing/extra
- secret detection counts and paths
- estimated database/storage size
- import order and rollback IDs

Import is transactional/idempotent, ordered `users → chats → sessions → media → messages →
requests → persona → memory → settings → tasks/scheduler-state` (so `messages` never reference
unimported `media` rows and request/scheduler state is preserved). It records source IDs/hashes
and creates a migration run ledger.

## Verify and rollback

Verify:

1. counts and checksums
2. no secret values in target DB/report
3. references resolve
4. selected conversations render read-only
5. fake OneBot/fake model smoke flow
6. plugin configurations validate

Rollback (replace the partial SQL row-delete fallback in `packages/migration/src/pipeline.ts`
with pre-import snapshot restoration as the authoritative rollback path):

1. stop runtime
2. restore SQLite databases (`domain.sqlite`, `durable.sqlite`) and blob/media store from the
   pre-import backup
3. verify backup hash
4. preserve reports and rollback audit records (keep row-level SQL rollback only for isolated
   in-memory/test runs after completing missing tables such as `chat_objects`, `identities`,
   `user_aliases`, and `requests`)

## Cutover

1. complete dry run
2. lab import and verify
3. freeze DSH
4. final snapshot
5. final import
6. verify
7. point NapCat to Tsukaima
8. smoke test on admin-selected conversations
9. keep DSH data untouched for rollback

## Tests

1. Snapshot manifest/hash/classification.
2. zstd v4 fixture parse/resume/unknown-field preservation.
3. Config mapping/review report and secret stripping.
4. Mnemon/NapCat memory/profile mapping.
5. Meme pack/index DB parsing and media dedupe.
6. Schedule/request mapping.
7. Dry-run counts and checksums.
8. Import idempotency/failure rollback.
9. Verify no secrets in target.

## Acceptance

A local copy of the real DSH deployment can be dry-run imported into a lab Tsukaima with a
complete review report and no secret leakage; rollback restores the lab state.
