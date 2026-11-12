# Bot domain model

## MessageEnvelope

Every inbound and outbound message is normalized before entering the conversation plane.

```ts
type MessageEnvelope = {
  id: string;
  channelId: string;              // e.g. onebot:napcat:99
  channelKind: "onebot-v11" | "webui" | "system" | "plugin";
  conversationKey: {
    kind: "private" | "group" | "webui" | "task";
    peerId?: string;              // QQ user id for private chat
    groupId?: string;
  };
  sender: {
    id: string;
    platformId: string;
    displayName: string;
    groupRole?: "owner" | "admin" | "member";
    isBot?: boolean;
  };
  target?: { id?: string; replyToEnvelopeId?: string };
  mentions: Array<{ id?: string; all?: boolean }>;
  parts: Array<MessagePart>;
  source: {
    messageId?: string;
    timestampMs: number;
    sequence?: number;
  };
  raw?: unknown;                  // retained for channel diagnostics
};
```

`MessagePart` is a discriminated union: text, image, sticker, audio, video, file, at, reply, json-card, reaction, location, or channel-native event. Raw channel payloads are retained at the message level, while normalized parts are what plugins normally consume.

## Activity Window

Messages are not immediately submitted as separate turns. The channel router groups an input burst into one Activity.

Rules:

- Window closes after configurable inactivity, default 6 seconds (range 3–10 seconds by conversation).
- Images followed by text, correction, and a sticker are one activity.
- If the agent is already processing, a late message can be submitted as a steer instead of waiting.
- Every raw message is persisted independently; aggregation metadata is stored separately.
- Long-running stateful interactions (approval, form, wait-for-user) may bypass normal aggregation and use durable signals.

## Conversation resolution

1. Resolve the adapter identity and account.
2. Resolve conversation by `(channelId, conversationKey)`.
3. Ensure canonical users exist for sender, mentioned users, and replied-to users.
4. Apply conversation policy: enabled, response mode, quiet hours, group trigger rules, allowlist, rate limits.
5. Apply activity aggregation.
6. Submit to durable conversation with idempotency key derived from channel message ID.

## Multi-user context

The model-visible user message is assembled from the activity, not a single sender string. A compact header includes:

- sender display name and stable alias
- platform ID when useful
- group role when relevant
- replied-to participant
- mentions
- relationship or prior-memory hints, only if policy permits

Raw transcripts remain available through tools. The model is not given every raw OneBot field by default.

## Users

The bot layer has its own canonical user table. WebUI has one administrator and is not the source of bot user identity.

User records include:

- canonical user ID
- channel identities (QQ, WebUI, future platforms)
- display names and aliases
- trust level
- contact policy
- relationship notes
- consent/visibility flags

QQ numbers are stable platform IDs, but bot logic should use canonical IDs so future channels can merge identities deliberately.

## Memory

Memory is explicit, scoped, and auditable.

| Scope | Purpose |
| --- | --- |
| global | Long-lived bot-wide facts and constraints |
| persona | Character traits, speech style, current persona state |
| user | Facts about a person, preferences, relationship |
| conversation | Local group/private-chat facts and running decisions |
| project | Self-iteration repositories, deploy decisions, plugin state |
| ephemeral | Temporary context, expires automatically |

Memory records contain `scope`, `subject`, `content`, `confidence`, `sourceConversationId`, `sourceEntryId`, `createdBy`, `updatedAt`, `expiresAt`, and `visibility`.

Extraction can run asynchronously after a turn. It must not block replies. Retrieval combines recent conversation context, semantic recall, and explicit facts. Injection is budgeted and policy-controlled.

## Persona

Personas are versioned records, not loose prompt text. A persona includes:

- identity, tone, language style
- safety and boundaries
- model policy hints
- sticker behavior
- proactive behavior
- fallback behavior
- example replies

Conversation persona bindings can be global or per-conversation. Persona changes are auditable and versioned.
