# Conversation policy and humanlike pacing spec

## Outcome

A single policy engine controls when a conversation responds, waits, lurks, delays, and emits;
the model receives a compact conversation contract instead of a DSH-specific prompt.

## Current boundary

Tsukaima has activity windows and durable steering/follow-up. It does not expose policy-driven
trigger/access controls, model-visible lurk decisions, cooldowns, burst-queue tuning, or
humanlike outbound pacing.

## Policy document

Extend the durable conversation policy without replacing existing fields. Recommended shape:

```ts
type ConversationTriggerPolicy = {
  privateAccess: "open" | "allowlist" | "disabled";
  groupAccess: "open" | "allowlist" | "disabled";
  allowlist: string[];
  keywords: string[];
  groupMentionMode: "always" | "smart" | "disabled";
  replyToBotCounts: boolean;
  stickerOnly: "wake" | "text-only" | "lurk" | "ignore";
  imageOnly: "wake" | "text-only" | "lurk" | "ignore";
  selfAliases: string[];
  peerBotIds: string[];
};

type ConversationPacingPolicy = {
  burstSettleMs: number;
  burstMaxWaitMs: number;
  burstMaxMessages: number;
  burstLongMessageThreshold: number;
  replyCooldownMs: number;
  typingEnabled: boolean;
  replyDelayEnabled: boolean;
  replyDelayMaxMs: number;
  sendIntervalMs: number;
  maxImmediateOutputMessages: number;
};
```

Persist as a versioned document with defaults, validation, and no silent partial update:

- Keep the domain `policies` table (`scope: "global" | "conversation"`) as the authoritative policy
  store and sync the active `tsukaima.conversationPolicy` durable document from it on update.
- Map legacy `activityAggregationPolicySchema` (`windowMs`, `maxMessages`) to `burstSettleMs` /
  `burstMaxMessages` and widen or remove the `3_000..10_000` ms clamp in
  `activityAggregationPolicySchema` and `shouldCloseActivityWindow()` to honor `burstMaxWaitMs`.
- This policy is the single owner of `privateAccess`, `groupAccess`, `allowlist`, `selfAliases`,
  `peerBotIds`, and reply pacing; channel plugins must not duplicate them.

## Trigger decision

Classify inbound activity for routing and model submission as one of:

1. `direct` — private chat, bot mention, reply to bot, or configured keyword/wake.
2. `soft` — bot alias/name appears, recently active, or allowed quiet participation.
3. `ambient` — persisted to `messages` (marked `suppressed`/`ambient` rather than entering
   activity submission) so group context and explainability remain intact.
4. `ignored` — rejected by access policy; drop before domain `messages` creation and record a
   rate-limited diagnostic/audit counter so unauthorized traffic cannot flood storage.

For a model-visible soft activity, append a compact trigger context section:

- direct vs soft
- whether bot name appeared without direct address
- whether another bot is speaking
- media/notice summary
- allowed decision marker

The model may return `TSUKAIMA_LURK` or a neutral response. This marker must be handled before
output dispatch, must be absent from outbound history, and must produce an audited no-send.

## Aggregation and queues

- Preserve burst settle/max-wait/max-count semantics.
- Long messages may terminate aggregation immediately.
- If the agent is active, steer until its grace window closes, then submit follow-up.
- During cooldown, aggregate rather than discard; do not queue another model run.
- Per-chat execution must be serialized with a shared conversation execution lock honored by
  inbound turns, steering/follow-ups, outbound pacing, and proactive/scheduled background turns,
  without globally blocking other chats.

## Humanlike output

Implement pacing as post-model output orchestration:

1. normalize ordered parts into message batches; each newline-separated text unit and each
   media part becomes a separate message, preserving the model's text/media order
2. strip Markdown/list formatting according to policy
3. optional bounded delay or typing indicator
4. send messages with interval and max immediate output
5. allow steering/cancel while messages remain queued

Do not rely on the model to understand internal transport rules beyond the compact contract.

## Persona routing

Persona binding remains host data. Add:

- global/default persona
- chat-object binding
- private/group override
- persona version and enabled state
- compact identity/policy section rendered before memory
- self aliases shared with trigger policy

Persona replacement must never silently expose runtime/implementation details.

## Admin UI

The conversation view needs read/update policy controls:

- trigger/access rules
- cooldown, burst, quiet hours, rate
- output chunking/delay/typing
- persona binding
- tool allowlist
- policy history

All mutations are authenticated and audited.

## Tests

1. Policy validation/default resolution.
2. Trigger classification for mention, reply, keyword, alias, peer bot, media-only.
3. Cooldown and burst queue behavior.
4. Lurk marker suppression and audit.
5. Output split/delay/cancel.
6. Persona binding resolution and prompt section.

## Acceptance

A chat can be configured from the WebUI to open, lurk, respond to mentions/keywords, merge
bursts, pace output, and use a distinct persona. No hardcoded QQ behavior exists in core.
