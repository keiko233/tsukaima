# NapCat operational parity spec

## Outcome

Tsukaima must operate as the sole bot process on the current NapCat deployment without losing
message fidelity, media, notice handling, or recoverable outbound delivery.

## Current boundary

- Forward WebSocket is implemented, including token headers, reconnect backoff, action
  timeouts, diagnostics, request inbox, and private/group sends.
- Inbound normalization covers text, reply, mention, image/sticker, and sender/group metadata.
- `MessagePart` only supports text, image, and sticker, with image/sticker represented by a
  SHA-256 string.
- Reply delivery is at-most-once with no pending reconciliation.

## Requirements

### Connection modes

1. Keep forward mode as the default.
2. Add reverse mode with local listener, `host`, `port`, token verification, origin/address
   diagnostics, and graceful shutdown.
3. Support hot-apply of URL, mode, token, bot account, and reconnect settings.
4. Expose connection state, last error class, event count, and restart state through the
   existing plugin diagnostics surface.

### Inbound fidelity

Tsukaima must normalize, or explicitly mark and store, these OneBot/NapCat cases:

| Class | Required result |
| --- | --- |
| `notice` | Dedicated `ChannelNotice` / `onNotice` envelope (do not overload `MessageEnvelope` where `parts.min(1)` fails): poke, revoke, emoji reaction, typing, ban, mute, group file/upload, title, member change. |
| Poke at bot | Persist as system/notice event and optionally wake under Phase 2 conversation policy; preserve sender attribution. |
| At mention | Keep the mention inline as text (`@name`, falling back to the QQ id when NapCat omits it) so the transcript, the WebUI, and the model see who was addressed; the ids stay in `mentions` for trigger classification. |
| Voice | Store original media and transcript; PTT-to-text uses a host/plugin STT capability with timeout/rate limit and fallback text. |
| Video | Store metadata and extracted representative frames. |
| File | Resolve URL/base64/local path, preserve name, MIME, size, hash, and source. |
| Forward bundle | Expand bounded node count/characters, preserve sender/text per node, fall back safely. |
| Card | Store JSON/XML/markdown payload; render safe whitelisted summary; never expose URLs/IDs to the model by default. |
| Unknown segment | Store `channel-native` part with type, safe fields, raw reference, and diagnostic. |

### Media model

Replace hash-only image/sticker fields in `messagePartSchema` with a media reference that contains:

- local storage `mediaId` (referencing the canonical `media` table) or content-addressed path
- optional `sha256` kept during migration so historical `messages.parts_json` rows remain readable
- MIME type, size, width/height/duration when known
- source URL or channel source reference
- safe preview metadata
- whether the model may receive the bytes

A core `MessagePart` union must include `text`, `image`, `sticker`, `audio`, `video`, `file`, and
`channel-native` while preserving read compatibility with legacy `{ type: "image" | "sticker", sha256 }` rows.

### Outbound actions

The NapCat plugin must expose a policy-gated action facade (using existing `ChannelCapability`
checks in Phase 1 and migrating to fine-grained capabilities in Phase 3). Minimum actions:

- send text, image, sticker, audio, video, file, and mixed message
- send with reply reference
- send combined messages or split a long reply (split/pacing schedule supplied by Phase 2)
- send forward bundle
- typing indicator where supported
- poke and emoji reaction
- delete own/authorized messages
- mark private/group read
- upload/list/fetch/delete group files according to policy
- generic OneBot action allowlist

All actions require capability checks, allowlists, audit records, timeout, retry semantics, and
plugin RPC names (`onebot-napcat.*`).

### Reply pipeline

1. Build outbound `MessagePart`s (applying Phase 2 pacing and Phase 3 outbound transform hooks).
2. Apply output policy: chunking, media selection, quote behavior, safety, rate limit.
3. Claim the outbound row.
4. Send through the channel adapter.
5. Store status and platform message ID.
6. Reconcile `pending` rows on startup and via a periodic job.

OneBot v11 `send_msg` has no client idempotency key, so reconciliation must follow a strict rule:
if the adapter exposes `read.history` / message lookup and confirms the message within a bounded
lookback window, mark `sent`; otherwise mark stale `pending` rows `uncertain` with an audit/diagnostic
warning. Never automatically resend an unconfirmed `pending` row across restarts.

### Access and management policy

- Conversation access gating (`open`/`allowlist`/`disabled`), self aliases, and peer bot IDs live in
  the Phase 2 core conversation policy engine so channel plugins do not duplicate policy state.
- Admins and admin titles are structured host/channel identity policy.
- Friend/group requests continue into the request inbox with timeout (`uncertain`) state.
- Group management actions (`manage.group`) are individually enabled and audited.
- Self account actions (`manage.self`) are individually enabled and admin-only by default.

### Tests

1. Forward/reverse connection and reconnect.
2. Every required inbound class round-trips into durable parts.
3. Outbound chunking, quote, media, and failure paths.
4. Pending reconciliation on restart.
5. Policy denial and audit for every destructive action.
6. A fake NapCat integration suite covering normal event/error/crash flows.

## Acceptance

Real NapCat can be connected in a lab without modifying the protocol package, send and receive
each listed media class, and restart without duplicate replies. Diagnostics and WebUI show
configuration, connection state, request handling, and pending deliveries.
