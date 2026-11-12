# Conversation flow

This document defines the end-to-end path from an inbound IM message to an outbound reply.

## High-level pipeline

```text
NapCat WebSocket event
  -> raw event validation
  -> channel adapter normalization
  -> canonical user/conversation resolution
  -> policy check
  -> durable raw message ingest
  -> activity aggregation
  -> activity close
  -> durable submission
  -> agent runner
  -> model/tool/plugin loop
  -> assistant output
  -> output policy
  -> outbound send action
  -> delivery confirmation
```

Every stage is observable and recoverable. A failure before durable ingestion can be dropped with a logged diagnostic; after durable ingestion it must remain visible.

## 1. Raw event intake

The OneBot channel receives a WebSocket event.

Responsibilities:

- parse the outer event envelope
- reject malformed events
- assign an internal receive ID
- deduplicate by platform message ID
- record connection status and last event time
- forward to the normalizer

The channel must not parse QQ semantics beyond the minimum needed for normalization.

## 2. Normalization

The adapter converts an OneBot event into a `MessageEnvelope`.

Responsibilities:

- map private/group event types
- extract sender, target, reply, mention, and message parts
- map text, image, sticker, audio, video, file, and JSON card parts
- preserve `raw` for diagnostics
- assign `channelId`
- derive `conversationKey`
- provide a stable `platformMessageId`

Unknown parts are represented as a generic `channel-native` part rather than dropped.

## 3. Identity resolution

The domain service resolves sender and mentioned users.

Rules:

1. Look up an existing identity by `(platform, botAccountId, externalId, kind)`.
2. If absent, create an identity and a canonical user.
3. Use existing display name if available; otherwise use the platform nickname.
4. Add a user alias for names not already present.
5. Never merge users automatically. Suspected duplicates become suggestions for admin review.

For groups, also resolve the group identity as an identity of `kind = 'group'` and create or update the conversation domain row.

## 4. Conversation resolution

Conversation keys:

| Kind | Key |
| --- | --- |
| private | `(channelId, kind=private, peerId)` |
| group | `(channelId, kind=group, groupId)` |
| webui | explicit admin conversation |
| task | created by task/plugin |
| plugin | created by plugin |

Resolution:

1. Find `conversations` by `(channel_id, platform_conversation_id)`.
2. If absent, create a domain conversation row.
3. Ensure the corresponding durable conversation exists.
4. Store `durable_conversation_id` in the domain row.
5. Return a `ResolvedConversation` object.

Do not create a new durable conversation for each message.

## 5. Policy check

Before durable ingest or reply, apply conversation policy:

| Policy | Default |
| --- | --- |
| enabled | true for imported/known conversations |
| response mode | `auto`, `mention-only`, `manual`, `disabled` |
| private allowlist | administrator-defined |
| group allowlist | administrator-defined |
| quiet hours | disabled by default |
| rate limit | conservative defaults |
| tool policy | conversation-level allow/deny |
| plugin policy | per-conversation enabled set |

Policy violations do not delete the raw message. The message is durably ingested as `ignored` or `suppressed` so history remains explainable.

## 6. Durable raw ingest

Each accepted or suppressed message is persisted before aggregation.

Store:

- durable entry for raw message
- domain `messages` row
- canonical sender reference
- platform message ID
- direction and kind
- occurred timestamp
- raw reference

Acknowledgement to NapCat is not required for every OneBot event. The critical guarantee is local durability before processing.

## 7. Activity aggregation

Messages in a conversation are grouped into an Activity.

### Opening an activity

Open when:

- no activity is collecting
- the message passes policy

The activity stores its trigger message and start time.

### Extending an activity

Extend while:

- activity is still `collecting`
- inactivity timer has not fired
- the message belongs to the same conversation

Every extension resets the inactivity timer.

### Closing an activity

Close when:

- inactivity timeout expires
- explicit close signal arrives from plugin
- maximum wait is reached

Default timeout is 6 seconds. Allowed range is 3–10 seconds.

### Special cases

1. **Agent already processing**
   - Keep activity window open for late messages for a shorter grace period.
   - Submit late messages as `steer` if agent is still running.
   - Otherwise submit as `follow-up`.
2. **Correction arrives after reply**
   - Create a new activity referencing the previous activity as context.
   - Do not rewrite prior history.
3. **Bot mentions in group**
   - Mention can trigger immediate processing if policy says so.
   - Still allow a short aggregation window.
4. **Media-only message**
   - Do not reply immediately unless policy requires.
   - Store as collecting activity.
5. **System event**
   - Persist if relevant.
   - Usually does not trigger a model turn.

## 8. Submission to durable conversation

When the activity closes, build a user-facing model context string from all normalized parts and participants.

The durable submission should:

1. Use an idempotency key based on activity ID.
2. Include canonical participant metadata.
3. Include memory retrieval result references.
4. Include persona binding.
5. Include policy-selected tool set.
6. Set `whenBusy` according to policy: usually `steer` or `follow-up`.

The activity becomes `processing`.

## 9. Context assembly

Assemble model context in layers:

1. Persona system prompt.
2. Conversation policy.
3. Conversation summary or compact history.
4. Recent raw conversation turns.
5. Current activity with participant labels.
6. Retrieved memory, with scope and confidence.
7. Available tools.
8. Plugin-injected instructions.

The model does not see raw OneBot JSON unless a tool explicitly requests it.

## 10. Agent turn

The agent runner submits the activity to `pi-durable`.

The runner must:

- select model by policy
- expose only allowed tools
- run plugin hooks
- capture usage
- handle model/provider errors as durable failures
- support steering during a run
- persist compaction when necessary

The chat-facing agent is not a coding agent by default. Coding tools appear only in coding or self-iteration conversations/tasks.

## 11. Tool execution

Tools are durable tasks where supported.

Tool policy:

| Class | Default |
| --- | --- |
| read-only | allowed |
| memory read | allowed with scope policy |
| memory write | explicit tool call, audited |
| channel send | allowed for assistant output |
| channel interaction | policy-controlled |
| group management | admin/policy controlled |
| coding execute | coding tasks only |
| deployment | proposal only |

Tool calls should produce model-visible results and UI-visible cards.

## 12. Output policy

After an assistant response:

1. Run plugin output hooks.
2. Split text/media if the channel requires.
3. Convert normalized output to OneBot message segments.
4. Apply rate limits and dry-run policy.
5. Create outbound send action records.
6. Send through NapCat.
7. Record delivery state.

Failure to deliver is visible in the conversation and task state. It is not silently retried forever.

## 13. Post-turn processing

After the model turn:

1. Mark activity `completed`.
2. Persist assistant references.
3. Queue memory extraction if enabled.
4. Queue conversation summarization if thresholds are reached.
5. Emit UI updates.
6. Run plugin `after_reply` hooks.

Post-turn tasks may be background durable tasks. They must not block the reply.

## 14. Compaction

Compaction is handled by `pi-durable`.

Policy:

- preserve recent raw messages
- summarize older history with a cheap model
- keep participant labels
- preserve decisions, relationships, and unresolved tasks
- preserve source IDs in summaries where possible

Never delete raw durable history during compaction.

## 15. Error paths

| Failure | Behavior |
| --- | --- |
| WebSocket disconnected | Reconnect with backoff; events missed while offline are not invented |
| Duplicate event | Discard with diagnostic |
| Normalization failure | Persist raw diagnostic if possible; do not process |
| Identity failure | Do not create duplicate identities; queue for admin review |
| Policy denial | Store suppressed message; no reply |
| Durable write failure | Fail request; process restarts and resumes |
| Model failure | Submission fails visibly; can be retried or continued |
| Tool failure | Return tool error to model/UI; do not crash conversation |
| Send failure | Record failed outbound action; expose manual retry |

## 16. Observability

Every stage logs structured fields:

- `requestId`
- `channelId`
- `conversationId`
- `activityId`
- `platformMessageId`
- `taskId`
- `pluginId`
- `modelProvider`
- `modelId`

Chat content must not be logged by default.
