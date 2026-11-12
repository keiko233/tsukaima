# Memory design

Memory is not a free-form scratchpad. It is scoped, auditable, versioned, and reviewable.

## Goals

- Let Tsukaima continue conversations across sessions.
- Separate private, conversation-local, persona, and project knowledge.
- Avoid accidental leakage between users.
- Allow admin review and correction.
- Preserve source references for trust and rollback.

## Scopes

| Scope | Reads may include | Writes belong to |
| --- | --- | --- |
| `global` | Bot-wide facts, constraints, preferences | Admin or explicitly approved extraction |
| `persona` | Character, tone, current persona state | Persona version or approved extraction |
| `user` | Facts about one canonical user | User-specific extraction or admin |
| `conversation` | Facts local to one private/group chat | Conversation extraction or admin |
| `project` | Self-iteration repos, deploy decisions, plugin state | Coding/runtime tasks |
| `ephemeral` | Temporary context with expiry | Runtime |

Retrieval never crosses user boundaries implicitly. A user-scoped memory is not injected into another user's private conversation.

## Record model

See `database.md` for exact columns. Conceptually:

```ts
type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  subjectUserId?: string;
  conversationId?: string;
  projectId?: string;
  kind: MemoryKind;
  content: string;
  summary: string;
  confidence: number;
  importance: number;
  sourceConversationId?: string;
  sourceEntryId?: string;
  sourceActivityId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  visibility: "private" | "admin" | "conversation";
  createdBy: "agent" | "user" | "migration" | "system";
};
```

`content` is the detailed record. `summary` is a short retrieval-oriented representation.

## Memory kinds

Use controlled kinds:

| Kind | Meaning |
| --- | --- |
| `fact` | Stable factual statement |
| `preference` | User or persona preference |
| `relationship` | Relationship or social context |
| `decision` | Agreed decision |
| `commitment` | Promise or pending action |
| `profile` | Structured profile data |
| `constraint` | Rule or boundary |
| `event` | Time-bound event |
| `project_state` | Coding/deployment/project state |
| `conversation_context` | Local conversation context |

Unknown kinds are rejected. New kinds require a schema migration and admin documentation.

## Retrieval pipeline

Memory retrieval has three layers:

1. **Explicit retrieval**
   - direct lookup by ID
   - direct user/conversation lookup
   - admin query
2. **Recent context**
   - newest conversation records
   - active activity participants
   - current persona binding
3. **Semantic recall**
   - query embedding or keyword search
   - scoped filters
   - confidence and importance weighting

The first release may use SQLite full-text search and deterministic filters. Embeddings are optional and should be stored in a dedicated index or extension table, not in the base memory row.

### Candidate generation

```text
query = current activity + sender + conversation topic
filters = scope policy + user + conversation + expiry + visibility
recall = recent + search/embedding candidates
ranking = importance, confidence, recency, source strength
deduplicate near-identical records
```

### Injection budget

Memory injection must have a token budget, defaulting to a small fraction of the context.

Suggested limits:

| Scope | Max records per turn | Purpose |
| --- | --- | --- |
| persona | 1 composite block | Character and tone |
| user | 5–10 | Personal facts/preferences |
| conversation | 5–15 | Local running context |
| project | 5–10 | Coding/project decisions |
| global | 3–5 | Bot-wide constraints |

Records are formatted compactly with scope and confidence. Do not inject raw source conversation content unless needed.

## Extraction pipeline

Extraction is a background durable task.

1. Take completed activity.
2. Build extraction prompt with activity and recent context.
3. Ask a cheap model to propose candidate memories.
4. Validate with Zod.
5. Deduplicate against existing scoped records.
6. Create memory candidates.
7. Optionally auto-approve based on confidence/kind policy.
8. Emit admin review items where confidence is low.

Extraction must not block the reply.

### Extraction output

```ts
type MemoryCandidate = {
  scope: MemoryScope;
  subjectUserId?: string;
  conversationId?: string;
  projectId?: string;
  kind: MemoryKind;
  content: string;
  summary: string;
  confidence: number;
  importance: number;
  sourceActivityId: string;
  sourceConversationId: string;
  sourceEntryIds: string[];
  expiresAt?: string;
};
```

The model may not invent source IDs. They are added by the extraction runner.

## Conflict and update policy

When a new memory overlaps an existing one:

| Situation | Action |
| --- | --- |
| Same subject and content | Skip duplicate |
| Same subject, newer preference | Create new record; mark old superseded if policy allows |
| Contradiction | Create candidate; admin review unless confidence is high and kind is replaceable |
| Sensitive fact | Require admin approval |
| Expired fact | Keep as historical; do not inject |

Memory updates are append-first. Hard edits are admin actions.

## Privacy rules

1. User memory is not visible in other users' conversations.
2. Conversation memory stays within that conversation.
3. Global memory must not contain user-specific private facts.
4. Admin can view all memory through review UI.
5. Model receives only permitted scopes.
6. Revoked memory remains in database for audit but is never injected.

## Forgetting

Three mechanisms:

1. `expiresAt` for ephemeral/time-bound records.
2. `revokedAt` for admin/user revocation.
3. Retention policy for obsolete low-importance records.

Do not physically delete automatically. Expiration only removes records from retrieval.

## Admin review

The WebUI must support:

- search by content, kind, scope, user, conversation
- view source conversation/activity
- approve/reject candidates
- edit summary/content
- revoke/restore
- inspect confidence and source

All edits are audited.

## Migration

DSH migration may generate memory candidates from:

- Mnemon-like stores
- persona files
- conversation summaries
- user preferences
- sticker behavior settings

Migration records preserve source hash and ID. LLM-generated migration memory must be marked `createdBy = 'migration'` and reviewed before activation where possible.
