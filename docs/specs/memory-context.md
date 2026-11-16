# Memory and context spec

## Outcome

Tsukaima preserves useful conversational and cross-session context without allowing memory to
become an unreviewed global prompt-injection channel.

## Current boundary

- `memories` has scoped content, importance, confidence, expiry, source, and revocation.
- Context injection is keyword-ranked with a 4000-character budget.
- There is no extraction job, no review API/UI, no archive turn, no shared memory, and no
  cross-session recent-context layer.

## Memory tiers

| Tier | Purpose | Store | Lifecycle |
| --- | --- | --- | --- |
| Recent | Exact conversation window | Durable entries | Existing durable retention |
| Warm | Rolling summary, people, setting, glossary, preference, todo, event | Scoped memory rows | Merged and expire/reviewed |
| Long-term | Durable facts and persona/project facts | Scoped memory rows | Explicit review/revocation |
| Shared | Cross-conversation general knowledge | `global`/`persona` scoped rows | Admin write or approved extraction |
| Cross-session | Recent activity by same user across conversations | Derived non-durable view | Configurable age/limits |

DSH Mnemon names are not imported as APIs; map its data into these tiers.

## Memory kinds and lifecycle

Use stable kinds:

`fact`, `summary`, `setting`, `person`, `preference`, `style`, `glossary`, `todo`, `event`,
`relationship`, `observation`.

Required metadata and `memories` schema additions:

- Add `status` (`"auto-approved" | "needs-review" | "rejected" | "revoked"`, backfilling existing
  rows to `"auto-approved"`), `dedupeKey`, `extractionModel`, `extractionPromptVersion`, and
  `evidenceJson` to `memories` in `packages/db/src/schema.ts`.
- source conversation/activity/entry
- created/updated by
- confidence/importance
- visibility
- optional expiresAt

Merging is update-or-replace, not unbounded append. Failed extraction cannot break the chat
turn. Todo/event expiry is executed by a scheduled job (`tasks.*` from Phase 3). Model-facing
memory tools use the `memory.<action>` namespace.

## Extraction

Add a durable background extraction task via `tasks.create` after activity settle:

1. Read the settled activity and relevant existing memory.
2. Use a compact extraction prompt/version.
3. Require JSON output with kinds, confidence, evidence ranges, expiry, and candidate merge
   operation.
4. Validate and classify as `auto-approved`, `needs-review`, or `rejected`.
5. Apply only allowed writes; record audit.

Capabilities/config:

- enable/disable per conversation/user/global
- model capability separate from chat
- minimum confidence/importance
- maximum writes per activity
- self-alias exclusion
- quiet hours/rate limits
- forbidden source content (e.g. private-to-group) honored

## Retrieval

The injection pipeline should be:

1. resolve scopes: conversation, users, persona, project, global
2. retrieve by vector or hybrid retrieval through a host/plugin `embedding` port (configured via
   Phase 3 `PluginModelProvider` extension and stored in SQLite embedding columns/`sqlite-vec`);
   keyword + recency ranking remains the fallback when no embedding provider is configured
3. boost importance, recency, same scope, kind
4. merge/compact duplicates
5. budget by tiers and section max chars
6. render compact labeled sections

The provider interface must accept conversation ID plus rich retrieval context. Existing
renderers remain usable during migration.

Cross-session context is generated from the derived view and is redacted according to policy:
private content must not enter a group by default.

## Review API/UI

Admin namespace:

| Operation | Behavior |
| --- | --- |
| `memory.list` | filters scope/kind/status/source conversation/user/date |
| `memory.get` | content, source, evidence, metadata |
| `memory.update` | content/kind/importance/visibility/expiry |
| `memory.approve` | promotes a candidate |
| `memory.reject` | rejects candidate |
| `memory.revoke` | preserves tombstone |
| `memory.purge` | destructive, backup/audit required |
| `memory.search` | retrieval test with score explanation |

UI groups by scope and kind, shows evidence/confidence/source, supports review queue, search,
and destructive confirmation. Content is never logged.

## Compaction and context budget

- Conversation summaries are memory rows, not rewrites of durable history.
- `pi-durable` continues managing its internal transcript compaction; Tsukaima background compaction
  operates additively by writing `summary` memory rows and pruning oversized tool results during
  context injection (`tsukaima-memory` / `tsukaima-persona`) without mutating `messages` or raw
  `pi-durable` entries.
- Use threshold+retention token policy; provider usage can drive a corrected estimate.
- Preserve exact original entries; compaction is additive.
- Record last compaction, budget, model, prompt version, and counts.
- Run compaction outside the user's synchronous reply path.

## Migration

For DSH data:

1. map Mnemon spaces/items/documents to scoped rows and archive files
2. map NapCat shared/cross-memory and human profiles
3. preserve provenance and timestamps
4. import as `needs-review` unless policy opts into auto approval
5. map DSH/NapCat compaction settings to the new policy

## Tests

1. Schema constraints and scope resolution.
2. Extraction validation, dedupe, expiry, and failure isolation.
3. Review transitions and audit.
4. Retrieval ranking/budget and cross-session redaction.
5. Compaction additive behavior and restart.
6. Migration fixture for Mnemon/NapCat/memory profiles.

## Acceptance

Memory can be extracted, reviewed, searched, expired, and used per-conversation. A compaction
job can run in the background without breaking durable history or reply delivery.
