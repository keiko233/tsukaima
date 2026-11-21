# Chat agent runtime refactor

## Outcome

Ordinary IM conversations (`private` and `group`) run as responsive, expressive, durable chat
agents with DSH-level freedom, execution efficiency, and natural persona continuity, while
preserving Tsukaima's durability, at-most-once delivery, typed contracts, auditability, and
strict separation from repository coding tools.

## Root-cause diagnosis

The post-cutover runtime audit identified four compounding architectural regressions relative to
the DSH baseline:

1. **Prompt and context corruption.** `DrizzleContextProvider` clips persona text at 1,600
   characters (`4_000 * 0.4`) with an injected truncation warning, ships an empty `chat-system`
   default, and injects English transport internals (`burstSettleMs`, `maxImmediateOutputMessages`,
   `stripMarkdown`) via `Conversation contract:`. Because `tsukaima-memory` embeds a rolling
   6-message window inside a `pi-durable` system section, every turn emits a new
   `Updated system prompt section` system message after the user turn instead of replacing prior
   context — breaking prefix caching, burying the persona at message `[0]`, and growing prompts
   unboundedly until compaction. Every user turn also permanently persists an English
   `Conversation trigger:` preamble, while `ambient` group messages never reach the transcript
   and survive only as 6 nameless `- inbound:` snippets. Inbound timestamps, quoted reply text,
   and resolved `@` display names are omitted from model input, and `pi-durable`'s default
   compaction prompt rewrites chat history into a coding checklist.
2. **Loop and IM pacing bottlenecks.** Default `burstSettleMs` is 8,000 ms (with 400-char
   long-message threshold), adding an 8-second dead-time floor to every normal short message.
   Multi-step tool runs re-render persona, policy, and memory (including DB queries and
   embeddings) on every tool round, emit no mid-turn narration (`observeAnswer` only delivers the
   terminal assistant entry), and hold `withConversationLock` across the entire outbound sleep
   and send burst. `recentActivity` promotes every group message for 5 minutes to a full-model
   `soft` turn just to emit `TSUKAIMA_LURK`, and `TSUKAIMA_LURK` anywhere in text drops the whole
   reply. `packages/core/src/openai.ts` lacks sampling parameters (`temperature`, `top_p`, `stop`)
   and per-request timeouts, and `finish_reason: "length"` is delivered as a finished reply.
3. **Unreachable and over-fragmented chat tools.** All 41 chat-facing plugin tools default to
   `lazy: true` behind `tool_search` with hash-suffixed model names, leaving the model unaware of
   its capabilities. Of the 26 `onebot-napcat` tools, 21 require a `platformConversationId` or
   `messageId` that never appears in prompts or `ToolInvocationContext`, and `list_targets` was
   removed; `onebot-napcat.send` also advertises `url`/`name` fields that fail `messagePartSchema`
   (`sourceUrl`/`fileName`). Sticker sending regressed from low-latency inline expression to a
   fragile two-tool + 120 s single-use token flow. `applySessionToolPolicy` stripped
   `workspace_spawn`, `workspace_send`, `session_lookup`, hooks, and host scheduling from IM even
   though `AGENTS.md` permits chat-to-workspace delegation without coding tools.
4. **Noisy memory and missing social behavior layer.** `Warm session state` uses CJK bigram
   frequency and regex keyword matching; extraction and compaction fire on both `after.reply` and
   `activity.closed` using the main chat model; embeddings run synchronously on the prompt render
   path; cross-session recency and `behaviorJson` persona settings are dropped; channel notices
   (such as pokes) are invisible to the model; and per-chat social familiarity learning,
   anti-repetition guards, and cheap pre-model gating are absent.

## Architectural invariants

- Keep `packages/contracts` as the single source of truth for all RPC and policy wire schemas.
- Keep ordinary IM turns free of repository-mutating coding tools (`self-iteration.*`, shell,
  repo edit/exec). Chat-to-workspace delegation uses governed session tools only.
- Preserve durable at-most-once reply delivery, reply expectations, crash recovery, and audit
  logging on privileged or destructive actions.
- Keep `pi.system` strictly static across ordinary turns so provider prefix/KV caches hit across
  turns and tool rounds; inject per-turn dynamic context ephemerally via `pi-durable` hooks.
- Never hardcode channel-specific identities, QQ numbers, or deployment details in `packages/core`.
- Keep all tests deterministic against SQLite, temporary directories, synthetic identities, and
  fake models.

## Batch breakdown

| Batch | Scope | Primary packages | Depends on |
| --- | --- | --- | --- |
| 1 | Static system prompt, ephemeral turn context, rich inbound rendering, chat compaction | `packages/core`, `packages/contracts`, `apps/server`, `plugins/onebot-napcat` | — |
| 2 | Responsive pacing, mid-turn narration, lock hygiene, sampling & request timeout | `packages/contracts`, `packages/core`, `apps/server` | Batch 1 |
| 3 | Eager chat tools, current-chat addressing, OneBot/media parity, sticker ergonomics | `packages/sdk`, `packages/core`, `apps/server`, `plugins/onebot-napcat`, `plugins/sticker-meme` | Batch 1 |
| 4 | IM-to-Workspace delegation and unified scheduling | `packages/contracts`, `apps/server`, `plugins/proactive-scheduler` | Batch 3 |
| 5 | Async semantic memory consolidation, cross-session awareness, hot-path cost removal | `packages/contracts`, `packages/db`, `apps/server` | Batch 1 |
| 6 | Social behavior learning, output humanization guards, cheap pre-model gating | `packages/contracts`, `packages/core`, `apps/server`, `plugins/proactive-scheduler` | Batch 2, Batch 5 |

Batches 2, 3, and 5 can proceed in parallel once Batch 1 lands.

---

## Batch 1 — Stable system prompt, ephemeral turn context, and chat-native compaction

### Design

- **Freeze the static system prefix.** Keep only stable prompt sections in `pi-durable`'s
  `pi.system` (`tsukaima-system`, `tsukaima-persona`, and compact static behavioral guidance).
  Remove `tsukaima-memory` and the rolling recent-message dump from `pi.system` so
  `planSystemEntries` never appends accumulating `Updated system prompt section` messages on
  every turn.
- **Unblock full personas and base chat framing.**
  - Raise the persona character ceiling from 1,600 chars to a configurable budget (default
    `12_000` chars) with no `[persona truncated …]` injection unless explicitly exceeded; reserve
    a separate budget for ephemeral turn context rather than splitting a shared 4,000-char cap.
  - Ship a concise, natural, non-assistant default for `DEFAULT_PROMPTS["chat-system"]` (still
    editable in Settings -> Prompts) that establishes colloquial IM conversation style and
    forbids leaking runtime/harness internals.
  - Honor persisted persona `behaviorJson` settings (such as `complete` and
    `includeRuntimeContext`) when composing the static system prefix instead of storing and
    ignoring them.
  - Remove transport plumbing (`burstSettleMs`, `burstMaxWaitMs`, `replyCooldownMs`,
    `maxImmediateOutputMessages`, `stripMarkdown`, raw access mode names) from `renderPolicy`.
    State only model-actionable behavior rules in natural language.
- **Ephemeral per-request context injection via `GenerationHooks.beforeRequest`.**
  - Register a `pi-durable` generation hook (`beforeRequest`) in `PiDurableConversationHost` that
    attaches transient turn context for that request only, without writing it into `pi.system` or
    durable transcript entries.
  - Compute and cache the turn's ephemeral context once per run (keyed by run/generation) so
    multi-step tool rounds reuse the same snapshot instead of re-querying SQLite and memory on
    every tool round.
  - Include in the ephemeral block (bounded by priority-ordered sections with budget-exempt core
    blocks): current local clock (`YYYY-MM-DD HH:mm` + weekday), ambient group observation window
    (up to 20 recent messages formatted with `[HH:mm] displayName(platformId)` and explicit self
    marker for bot replies), recalled memories, active prompt hooks, and a compact trigger cue
    only when the turn is `soft`.
- **Clean, human-grounded durable user turns.**
  - Stop prepending `Conversation trigger:` telemetry blocks to persisted user messages in
    `envelopesToText`. Keep durable transcript entries clean: per-message local time, resolved
    speaker display name (plus compact platform ID in group chats), resolved `@` mention display
    names (reusing `mention-labels` resolution on ingest/render, not WebUI-only), and quoted
    reply excerpts (`normalize.ts` must preserve `reply` metadata and resolve quoted message
    author + excerpt before formatting).
- **Chat-native compaction via `CompactionHooks.beforeCompact`.**
  - For non-workspace conversations (`private`, `group`, `webui`), intercept `beforeCompact` and
    summarize with a dedicated chat-compaction prompt (configurable via `prompts`) that preserves
    active topics, participant relationships, promises/plans, inside jokes, and recent emotional
    tone — never coding headers (`## Goal`, `## Done`, exact file paths). Keep the coding
    compaction format for `workspace` sessions.

### Acceptance

- A multi-turn test (≥6 turns) against a deterministic fake model verifies:
  1. Exactly one `role: "system"` message exists at index `0` across all turns (zero accumulating
     `Updated system prompt section` system messages).
  2. A 6,000-char persona is delivered intact without truncation notes.
  3. Multi-round tool execution invokes the context/memory provider once per run, not once per
     tool round.
  4. User messages in the durable transcript contain timestamps, resolved `@` names, and quoted
     reply excerpts, and contain zero `Conversation trigger:` preambles.
  5. Ambient group messages appear in the ephemeral observation block with speaker names and
     timestamps, and bot self-messages are marked distinctly.
  6. Compaction on a chat conversation uses the chat summarization prompt via `beforeCompact`,
     while a `workspace` conversation retains the coding compaction format.
- Context Inspector output matches the actual static prefix + ephemeral context sent to the model.

---

## Batch 2 — Responsive IM pacing, mid-turn narration, lock hygiene, sampling & timeout

### Design

- **Eliminate the 8-second dead-time floor.**
  - Update `conversationPacingPolicySchema` defaults in `packages/contracts/src/policy.ts`:
    `burstSettleMs: 1_200`, `burstMaxWaitMs: 5_000`, `burstLongMessageThreshold: 32`.
  - Allow immediate submission (bypassing the full settle wait) when a single inbound message is a
    direct address (`private` chat, `@bot`, reply-to-bot, or wake keyword) and ends with terminal
    sentence/question punctuation or exceeds `burstLongMessageThreshold`, unless another message
    arrived within a short active-burst window (e.g. ≤1,500 ms).
  - Add a policy option (and sensible default) so `recentActivity` does not blindly escalate
    every ambient group message into a full-model `soft` inference; keep direct/alias/reply
    triggers responsive while preventing token-burning lurk loops.
- **Mid-turn narration on tool calls.**
  - Hook `GenerationHooks.afterResponse` in `PiDurableConversationHost`: when a user-facing chat
    run produces an assistant message with `stopReason === "toolUse"` and substantive non-empty
    `text` blocks (not a lurk marker, not a background/proactive turn, not preceded by a direct
    send-message tool in the same round), emit a rate-limited mid-turn narration callback to
    `ReplyDispatcher`.
  - Persist narrated messages with at-most-once deduplication (keyed by durable entry/round id)
    and suppress duplicate emission if the model already sent via a channel send tool during the
    turn.
- **Release `withConversationLock` before outbound network sleeps.**
  - Refactor `ReplyDispatcher.#deliver` so claiming the dispatch intent and writing the outbound
    DB row happen inside a short critical section, while typing indicators, pre-reply delay, and
    inter-bubble `sendIntervalMs` sleeps run outside `withConversationLock`. New inbound messages
    must never stall behind a multi-bubble send burst.
  - Narrow inbound output cancellation (`cancelPendingOutput`): cancel remaining queued bubbles
    only on a direct interrupting message from the same conversation, not on unrelated ambient
    group chatter.
- **Safe lurk semantics and length-truncation handling.**
  - Update `extractLurkMarker` so `TSUKAIMA_LURK` suppresses the reply only when the trimmed
    response *is* the marker (optionally surrounded by whitespace/punctuation), rather than letting
    an incidental mention of the token delete a full substantive reply.
  - Detect `stopReason === "length"` in the run observer: attempt one automatic bounded
    continuation (via `onYield`) or log and surface truncation cleanly instead of silently
    shipping a mid-word cut.
- **Model sampling controls and request timeouts.**
  - Extend `OpenAICompatibleModelConfig` / `OpenAIRequest` in `packages/core/src/openai.ts` and
    conversation/runtime settings contracts to support optional `temperature`, `top_p`, `stop`,
    and `requestTimeoutMs` (default e.g. `60_000 ms` total / idle SSE timeout).
  - Enforce `AbortSignal.timeout` / idle-stream watchdog on `fetch` and SSE reading in
    `openai.ts` so a stalled upstream stream aborts cleanly and triggers `pi-durable`'s retry
    policy instead of wedging the conversation forever.
- **Channel notice awareness.**
  - Allow configurable channel notices — specifically self-targeted `poke` — to enter the
    observation log and optionally trigger a synthetic wake turn (subject to access policy and
    cooldown), instead of silently hiding all notices from the model.

### Acceptance

- Deterministic tests verify:
  1. Direct short question with terminal punctuation flushes immediately instead of waiting 8 s;
     rapid multi-message bursts still merge within `burstSettleMs` / `burstMaxWaitMs`.
  2. A multi-round fake model run emitting preamble text + tool call dispatches the narration
     before the tool finishes, then delivers the final answer without duplication.
  3. Inbound `host.append` completes immediately while a multi-bubble outbound delivery is
     sleeping between messages.
  4. `TSUKAIMA_LURK` alone suppresses output; a reply mentioning the token inside prose is not
     wiped.
  5. A hung fake HTTP stream aborts on `requestTimeoutMs` and retries instead of deadlocking;
     `temperature` / `top_p` / `stop` appear in the outbound OpenAI JSON request when configured.
  6. A self-targeted poke notice wakes the conversation when enabled by policy and respects
     cooldown/access denials.

---

## Batch 3 — Eager chat tools, current-chat addressing, OneBot/media parity, and sticker ergonomics

### Design

- **Curated eager toolset for IM chat.**
  - Update plugin tool policy defaults/declarations so high-frequency IM tools are eager
    (`lazy: false`) on `chat` surfaces: `onebot-napcat.send`, `readHistory`, `viewImage`, `poke`,
    `react`, `listTargets`, `sticker-meme.send` (and `search`), `search-fetch.web` / `fetch`,
    `memory.recall` / `save`, and active scheduling tools. Keep destructive group-admin,
    account-management, and diagnostic tools deferred behind `tool_search`.
  - Simplify `providerSafeToolName` in `packages/sdk/src/bridges.ts` so clean names (e.g.
    `onebot_napcat__send` or `memory__save`) avoid opaque 8-char hash suffixes unless truncation
    or collision requires disambiguation; keep backward compatibility for existing allowlists and
    audit logs.
  - Ensure a transient DB read error in `applySessionToolPolicy` does not wipe a conversation's
    tool allowlist to `[]` permanently without recovery on the next turn.
- **Current-chat and message-ID addressing in `ToolInvocationContext`.**
  - Extend `ToolInvocationContext` (`packages/sdk/src/types.ts`) and `PluginHost.toolPolicyContext`
    (`apps/server/src/services/plugin-host.ts`) to expose the active conversation's
    `platformConversationId`, `chatKind`, `channelId`, and `senderPlatformId` (already resolved
    on `ResolvedConversation`).
  - Update `onebot-napcat` action tools (`send`, `sendForward`, `readHistory`, `poke`, `react`,
    `listGroupFiles`, `fetchGroupFile`, etc.) so `target` defaults to the current conversation
    when omitted. Cross-chat sends still require explicit `target` and policy authorization.
  - Include compact `[msg:<id>]` references on recent inbound messages in the ephemeral context
    block (and in `readHistory` results) so `react`, `lookupMessage`, and `forwardMessage` have
    valid IDs.
- **Fix `onebot-napcat` schema bugs and restore key DSH channel/media tools.**
  - Fix `MESSAGE_PART_SCHEMA` in `plugins/onebot-napcat/src/index.ts` so advertised image/file
    part schemas match `messagePartSchema` (`sourceUrl` / `fileName`, or normalize `url`/`name`
    aliases in `asParts`).
  - Add `onebot-napcat.listTargets` (policy-filtered allowed groups/friends),
    `onebot-napcat.viewImage` (on-demand download/read of a recent, indexed, or message-scoped
    inbound image or sticker returning image content blocks to vision-capable models), and
    `onebot-napcat.forwardMessage` (forward existing message IDs).
  - Wire `ONEBOT_VIDEO_FRAME_EXTRACTOR_BINDING` and `ONEBOT_AUDIO_TRANSCRIBE_BINDING` in
    `apps/server/src/lifecycle.ts` when host media/transcription capabilities are configured,
    with bounded timeouts and graceful text fallback when unavailable.
  - Suppress duplicate final-text dispatch in `ReplyDispatcher` when the model already delivered
    its textual response to the current chat via `onebot-napcat.send` in the same turn (while
    still forwarding standalone media/sticker parts).
- **Low-friction sticker and meme expression.**
  - Support **inline marker expression** (`[表情:描述]` or `[sticker:描述]`) in
    `plugins/sticker-meme/src/output.ts` resolved directly against `StickerService`'s
    deterministic library matcher during `reply.transform` (one sticker per turn by default,
    sending as animated sticker `sub_type=1`), plus occasional ready-to-copy caption hints in
    ephemeral context when stickers are enabled.
  - Add a single-step `sticker-meme.send` tool (query/caption -> resolve & send or return part
    directly in one call) alongside existing `search`/`choose` for backward compatibility,
    eliminating the mandatory 3-round `tool_search -> search -> choose -> [[sticker:token]]`
    gauntlet.

### Acceptance

- A fake model in an IM group session sees the curated eager tools on its **first** request
  without calling `tool_search`.
- Calling `onebot-napcat.send`, `readHistory`, `poke`, and `react` with no explicit `target`
  addresses the active synthetic group/private chat; `send` with an image part passes schema
  validation and reaches the fake channel adapter; `listTargets` returns policy-allowed targets
  only; `viewImage` returns stored/fetched image content for a recent message.
- Writing `[表情:<caption-or-keyword>]` in an assistant reply resolves to a sticker media part
  without any tool call; `sticker-meme.send` works in one tool call; existing `[[sticker:<token>]]`
  tests continue to pass.
- Redundant assistant text after an explicit `onebot-napcat.send` to the same chat is not
  double-sent.

---

## Batch 4 — IM-to-Workspace delegation and unified scheduling

### Design

- **Restore governed IM-to-Workspace delegation.**
  - Update `applySessionToolPolicy` in `apps/server/src/lifecycle.ts` to match `AGENTS.md`:
    authorized IM conversations (controlled by explicit conversation/admin policy, e.g.
    `workspaceDelegationEnabled` or trusted admin speaker) receive `workspace_spawn`,
    `workspace_status`, `workspace_send`, and `session_lookup`, while **never** receiving
    `self-iteration.*`, `CODING_AGENT_TOOL_NAMES`, or `WORKSPACE_CODING_TOOL_NAMES`.
  - Audit every workspace spawn/send initiated from an IM conversation with caller identity and
    origin session metadata, and deny unauthorized non-admin speakers fail-closed.
- **Unify scheduling for IM.**
  - Reconcile the split between host `schedule_*` tools (`apps/server/src/services/schedule-tools.ts`)
    and `proactive-scheduler.*` (`plugins/proactive-scheduler/src/tools.ts`): expose absolute
    ISO timestamps, timezone handling, recurrence, and `cancelIfReplied` / flex-window semantics
    to IM sessions through one consistent scheduling tool family (backing onto the durable
    scheduler service), removing duplicate/conflicting schemas.
  - Change quiet-hours handling for one-off reminders: defer/reschedule past quiet hours instead
    of permanently marking a user-requested reminder `skipped`.
- **Clarify plugin runtime boundary.**
  - Audit `PluginHost.install` (`apps/server/src/services/plugin-host.ts`): either wire
    `BunPluginWorker` with full tool schema registration for out-of-tree plugins or enforce an
    explicit error/capability flag rejecting tool-bearing third-party installs until worker tool
    schemas are supported, rather than silently registering a no-op stub.

### Acceptance

- An authorized IM conversation can spawn a Workspace session, check its status, and exchange
  messages with it while attempting any coding tool in the IM turn is denied and audited.
- A non-admin speaker in a group chat cannot spawn or message workspaces (fail-closed + audited).
- An IM conversation can create a timezone-aware absolute-time reminder and a recurring schedule;
  a one-off reminder landing inside quiet hours is deferred to quiet-hours end rather than
  permanently dropped.
- `PluginHost.install` behavior is explicit and tested for non-builtin plugin manifests.

---

## Batch 5 — Async semantic memory consolidation, cross-session awareness, and hot-path cost removal

### Design

- **Remove synchronous hot-path bloat.**
  - Delete `RECENT_MESSAGE_LIMIT = 6` nameless echo from `DrizzleContextProvider.#format`
    (replaced by Batch 1's named, timestamped ephemeral observation window).
  - Remove synchronous network embedding calls from `MemoryService.recall` on the prompt-render
    path: compute and store embeddings asynchronously on memory write/backfill, and bound read
    latency with local vector/lexical scoring over already-embedded rows.
  - Eliminate duplicate post-turn extraction/compaction triggers: coalesce extraction and
    consolidation into one idle-debounced durable background job per conversation (e.g. after N
    new messages or idle window), never firing duplicate overlapping LLM calls on both
    `after.reply` and `activity.closed`.
- **Replace regex `Warm session state` with merge-not-append semantic consolidation.**
  - Replace the regex/CJK-bigram harvester in `MemoryService` (`Topic`, `Decisions`, `Todos`,
    `Open threads`) with an isolated background consolidation pass that reads the settled delta +
    existing rolling state and outputs a **merged** structured payload: rolling summary (bounded),
    per-person cards (keyed by canonical user/name), group atmosphere/glossary, and real
    commitments/todos with expiry.
  - Replace the 1-line `DEFAULT_PROMPTS["memory-extraction"]` with a structured, persona-safe
    extraction prompt that excludes self-identity rewrites, jokes/phatic chatter, and cross-scope
    leaks; support a dedicated lightweight `memoryExtractModel` default separate from the main
    chat persona model.
  - Add bounded retry/drop policy (e.g. max 3 failures per batch) so a malformed extraction never
    loops infinitely.
- **Restore privacy-preserving cross-session awareness.**
  - Add a derived cross-session recency query (configurable window and char budget in
    `ConversationPolicy`, restoring the DSH migration config fields dropped during normalization)
    that surfaces where the current speaker recently interacted across chats.
  - Enforce fail-closed privacy redaction: `private -> group` never copies private message text
    by default (coarse indicator only unless explicitly allowed by policy); unknown speaker
    yields empty cross-session context.
  - Add lightweight QA consistency recall for recently answered recurring questions within a
    conversation so the bot does not contradict itself across turns.

### Acceptance

- Prompt rendering performs zero network embedding calls on the request path and executes within
  a bounded query budget.
- Sending 5 consecutive messages and receiving 1 reply triggers at most one coalesced background
  consolidation job (not separate overlapping `after.reply` + `activity.closed` LLM runs).
- Jokes or phatic lines ("哈哈", "什么", casual questions) are not converted into bogus
  `Topic` / `Decisions` / `Todos` warm state.
- Cross-session context includes same-user group continuity while proving private chat content
  never leaks into group prompts under default policy.
- Schema/contract changes (if any new policy fields or consolidation tables are added) live in
  `packages/contracts` and use generated Drizzle migrations in `packages/db`.

---

## Batch 6 — Social behavior learning, output humanization guards, and cheap pre-model gating

### Design

- **Per-conversation social familiarity profile (`HumanProfile`).**
  - Persist a lightweight per-conversation social profile (migrated cleanly from DSH
    `human-profiles.json` where present): interaction count, who initiates (`otherFirst` /
    `selfFirst`), proactive answer rate, unanswered streak, explicit refusal timestamp, active
    hour histogram, and derived familiarity level (`L0` cold / `L1` normal / `L2` close; admin
    DMs / designated home chats may default to `L2`).
  - Enforce hard safety gates on proactive/bubble turns regardless of level: quiet hours,
    explicit refusal cooldown (e.g. 48 h), consecutive unanswered silence (e.g. 24 h), and
    recent self-message ratio ceiling (>40% in recent window).
  - Derive proactive/bubble budgets from the profile level, capped downward by admin policy, and
    record proactive quota consumption **only** when a turn actually produces outbound content
    (never on gate skip, `__SKIP__`/`TSUKAIMA_LURK`, or provider error).
- **Output humanization guards.**
  - Track recent bot replies per conversation to detect overused catchphrases/ticks and inject a
    compact dynamic avoid-list into ephemeral context (with optional single-retry rewrite guard
    for severe repetition).
  - Track recent reply rhythm (bubble count pattern) and inject a light variety nudge when
    consecutive replies become mechanically identical.
  - Add outbound meta-leak sanitization before channel delivery (stripping leaked template tags,
    internal placeholder tokens, or instruction echoes with warn-level diagnostics).
  - Add optional hour- and length-shaped human reply delay curve (capped) and DM typing
    indicator support, disabled or short by default in tests and configurable per policy.
- **Optional cheap pre-model gating and fast-lane busy interjection.**
  - Define a pluggable, fail-open `ConversationGatePort` (supporting either a lightweight
    classifier endpoint or small fast model, with circuit breaker after consecutive failures) for
    three decisions: burst completion (`SEND`/`WAIT`), undirected group reply (`REPLY`/`SKIP`),
    and proactive bubble (`SHOULD`/`SKIP`). When unconfigured or unhealthy, degrade cleanly to
    deterministic policy rules without blocking traffic.
  - Refine busy handling (`sidechat`): allow an optional fast-lane interjection path for direct
    named/urgent messages while a long main turn is working, using minimal context + one-line
    persona/relation anchor while strictly excluding identity probes and trailing follow-ups (which
    remain on the main conversation).

### Acceptance

- Social profile tests prove L0/L1/L2 promotion/demotion, refusal 48 h silence, unanswered 24 h
  silence, self-ratio >40% gate, and non-consumption of proactive quota on skipped/failed turns.
- Output guard tests prove dynamic overused-phrase detection, meta-leak stripping, and bounded
  delay curves.
- Gate tests prove fail-open behavior on timeout/error, circuit-breaker trip and recovery, and
  zero main-model invocations when an undirected group message is gated `SKIP`.
- Busy interjection tests prove identity probes and simple follow-ups never route to fast-lane
  interjection, while urgent direct questions receive an anchored fast reply without corrupting
  main-turn state.

---

## Delivery

- Land batches in dependency order (Batch 1 first; Batches 2, 3, and 5 may run in parallel;
  Batch 4 follows Batch 3; Batch 6 follows Batches 2 and 5).
- Each batch lands in its own focused PR with targeted unit/integration tests and passes
  `bun run check` and `bun run check:secrets`.
- Update WebUI Settings/Inspector copy in both `apps/web/messages/en.json` and
  `apps/web/messages/zh-cn.json` whenever policy or prompt fields are added.
- Update `docs/project-state.md` as each batch completes.
