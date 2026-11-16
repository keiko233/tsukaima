# OneBot / NapCat integration

Tsukaima's first channel is NapCat's OneBot v11 WebSocket server. Tsukaima is the WebSocket client. This preserves the current DSH topology and makes cutover straightforward.

## Transport modes

| Mode | Role | First release |
| --- | --- | --- |
| Forward WebSocket | Tsukaima connects to `ws://napcat:3001` | Yes |
| Reverse WebSocket | NapCat connects to Tsukaima | Later |
| HTTP server | NapCat accepts API calls | Optional |
| HTTP client | Tsukaima calls NapCat HTTP | Optional |

WebSocket is the primary event channel. HTTP may be used for API calls when useful, but actions must still be recorded and correlated.

## Connection

### Configuration

The channel is provided by the built-in `onebot-napcat` plugin
(`plugins/onebot-napcat`). Its configuration is stored per plugin in the domain `meta`
table under `plugin-config:onebot-napcat` and validated against the plugin's `configSchema`.
Any key can fall back to an environment variable through the manifest's `configEnv` map:

| Config key | Environment fallback | Secret |
| --- | --- | --- |
| `wsUrl` | `TSUKAIMA_ONEBOT_WS_URL` | no |
| `accessToken` | `TSUKAIMA_ONEBOT_ACCESS_TOKEN` | yes |
| `channelId` | - | no (defaults to `onebot`) |
| `botAccountId` | - | no (defaults to `tsukaima-server`) |
| `reconnect` | - | no |

Clearing a stored value falls back to the environment value, matching provider settings.
Secret keys are never returned by the settings API.

The plugin builds this into the protocol config:

```ts
type OneBotConfig = {
  channelId: string;
  botAccountId: string;
  url: string;
  accessToken?: string;
  reconnect: {
    initialDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
  };
  actionTimeoutMs: number;
  maxInFlightActions: number;
  apiMode: "websocket-first" | "http-only" | "hybrid";
};
```

The access token exists only in the secret store. It must not be logged or included in diagnostics.

### Reconnect policy

1. Attempt connection.
2. On disconnect, wait with exponential backoff and jitter.
3. Cap delay at configured maximum.
4. Reset backoff after a successful connection.
5. Expose status through health API.
6. When the channel URL or access token changes at runtime, stop the current channel and
   start a replacement with the new settings; no process restart is required. Saving
   unchanged settings does not touch the live connection.

Do not reconnect infinitely with no telemetry. Emit structured disconnect events.

The plugin subscribes to its own settings, so changing `wsUrl` or `accessToken` stops the
current channel and starts a replacement without a process restart. Saving unchanged
connection settings does not touch the live connection. `channel.connected` and
`channel.disconnected` hooks fire on connection-state transitions.

### Deduplication

Maintain a bounded recent-message cache per channel:

```ts
type DuplicateCacheEntry = {
  platformMessageId: string;
  receivedAtMs: number;
};
```

Discard duplicates with a diagnostic. The cache is process-local; after restart, the idempotency check in conversation ingestion is the second defense.

## Event normalization

### Outer envelope

The adapter accepts and validates:

```ts
type OneBotEventBase = {
  time: number;
  self_id: number | string;
  post_type: "message" | "notice" | "request" | "meta_event";
};
```

Unknown `post_type` values are stored as channel diagnostics and are not processed.

### Message events

Private message:

```ts
type PrivateMessageEvent = OneBotEventBase & {
  post_type: "message";
  message_type: "private";
  sub_type: string;
  user_id: number | string;
  message: OneBotSegment[];
  raw_message?: string;
  message_id: number | string;
  user_id_name?: string;
  sender: {
    user_id: number | string;
    nickname?: string;
    card?: string;
    sex?: string;
    age?: number;
  };
};
```

Group message:

```ts
type GroupMessageEvent = OneBotEventBase & {
  post_type: "message";
  message_type: "group";
  sub_type: string;
  group_id: number | string;
  user_id: number | string;
  anonymous?: unknown | null;
  message: OneBotSegment[];
  raw_message?: string;
  message_id: number | string;
  sender: {
    user_id: number | string;
    nickname?: string;
    card?: string;
    role?: "owner" | "admin" | "member";
    level?: number | string;
  };
};
```

Implementations must be tolerant of extra fields and numeric/string ID variants.

### Segment mapping

| OneBot segment | Tsukaima part | Notes |
| --- | --- | --- |
| `text` | text | Preserve text as received |
| `face` | sticker | QQ face/sticker |
| `image` | image or sticker | Use metadata/heuristic to distinguish when possible |
| `record` | audio | Resolve media through API |
| `video` | video | Resolve media through API |
| `at` | mention | Track user and `@all` |
| `reply` | reply | Preserve target message ID |
| `forward` | generic | Resolve if needed; otherwise store reference |
| `node` | generic | Part of merged forward message |
| `json` | json-card | Retain parsed/raw data |
| `xml` | generic | Rare; retain raw |
| unknown | channel-native | Never drop silently |

Tsukaima preserves segment order. `raw_message` is not treated as authoritative when segments exist.

### Media handling

1. Store file references immediately.
2. Download through controlled APIs.
3. Hash content with SHA-256.
4. Create media metadata.
5. Reference media ID in normalized parts.

Do not fetch arbitrary URLs embedded in messages. Media APIs are permission-gated.

## Notice and request events

The first implementation should durably log and surface, not necessarily model-process:

| Event | Purpose |
| --- | --- |
| friend add | Identity/contact state |
| friend recall | History correction |
| group increase | Membership event |
| group decrease | Membership event |
| group ban | Moderation context |
| friend poke / group poke | Interaction context / plugin trigger |
| group admin change | Member role update |
| group message recall | Message correction |
| essence events | Group context |

Requests:

| Event | Purpose |
| --- | --- |
| friend add request | Admin review or policy decision |
| group add/invite request | Admin review or policy decision |

Notice/request events are not chat turns unless a plugin and policy explicitly trigger one.

## Meta events

Handle:

- `heartbeat`: update connection status only.
- `lifecycle`: identify connect/reconnect.

Do not submit meta events to model conversations.

## Action facade

Plugins and output policies use a typed facade; they do not call raw WebSocket JSON directly.

### Core sending

| Action | Facade method |
| --- | --- |
| `send_private_msg` | `sendPrivate` |
| `send_group_msg` | `sendGroup` |
| `send_msg` | `send` |
| `delete_msg` | `recall` |

### Interaction

| Action | Facade method |
| --- | --- |
| `send_like` | `sendLike` |
| `friend_poke` / `group_poke` / `send_poke` | `poke` |
| `set_input_status` | `setInputStatus` |

### Group management

| Action | Facade method |
| --- | --- |
| `set_group_kick` | `kickMember` |
| `set_group_ban` | `banMember` |
| `set_group_whole_ban` | `banAll` |
| `set_group_admin` | `setAdmin` |
| `set_group_card` | `setMemberCard` |
| `set_group_name` | `setGroupName` |
| `set_group_leave` | `leaveGroup` |
| `set_group_special_title` | `setSpecialTitle` |

### Read/info

| Action | Facade method |
| --- | --- |
| `get_login_info` | `getLoginInfo` |
| `get_stranger_info` | `getStrangerInfo` |
| `get_friend_list` | `getFriendList` |
| `get_group_info` | `getGroupInfo` |
| `get_group_list` | `getGroupList` |
| `get_group_member_info` | `getGroupMemberInfo` |
| `get_group_member_list` | `getGroupMemberList` |
| `get_msg` | `getMessage` |
| `get_forward_msg` | `getForwardMessage` |
| `get_image` | `getImage` |
| `get_record` | `getRecord` |
| `can_send_image` | `canSendImage` |
| `can_send_record` | `canSendRecord` |
| `get_status` | `getStatus` |
| `get_version_info` | `getVersionInfo` |

### NapCat extensions

Expose grouped, permission-gated wrappers only when needed:

| Capability group | Examples |
| --- | --- |
| AI voice | `get_ai_characters`, `get_ai_record`, `send_group_ai_record` |
| Album/group context | NapCat album/comment/sign APIs |
| Emoji/faces | `fetch_custom_face`, `fetch_emoji_like` |
| Recent/history | `get_recent_contact`, group history APIs |
| Mini app/cards | `get_mini_app_ark`, Ark share APIs |
| File upload | OneBot/NapCat upload APIs |
| Status | `nc_get_user_status`, `nc_get_packet_status` |

Extensions must not be blindly whitelisted. Each group has a policy and audit level.

### Raw passthrough

```ts
await channel.raw(action, params, { permission: "channel.raw" });
```

Rules:

- requires explicit permission
- timeout applies
- records action, params, result summary, and error
- no credential-reading action is exposed by default

Credential actions are disabled or separately gated:

- `get_cookies`
- `get_csrf_token`
- `get_credentials`

## WebSocket protocol

### Outbound action

```json
{
  "action": "send_group_msg",
  "params": {
    "group_id": 123,
    "message": [
      { "type": "text", "data": { "text": "hello" } }
    ]
  },
  "echo": "<uuid>"
}
```

### Response

```json
{
  "status": "ok",
  "retcode": 0,
  "data": { "message_id": 456 },
  "echo": "<uuid>"
}
```

The client:

1. Assigns a UUID echo ID.
2. Records action with state `pending`.
3. Maps response by echo.
4. Applies timeout.
5. Marks `sent`, `failed`, or `timeout`.
6. Updates durable/domain records through service APIs.

### In-flight limits

- Cap concurrent actions.
- Queue excess actions per conversation and channel.
- Do not block event ingestion behind action queue.

## Permissions and policy

| Group | Examples | Default |
| --- | --- | --- |
| send | private/group messages | Allowed for bot output |
| interact | poke, reactions, likes | Policy-controlled |
| read.info | member/group info | Allowed |
| read.media | image/record/file | Policy-controlled |
| manage.group | ban/kick/admin | Admin or explicit policy |
| upload.file | group/private file | Policy-controlled |
| raw | arbitrary action | Disabled by default |
| credentials | cookies/token | Disabled |

Actions that can affect real QQ users require audit and are rate-limited.

## Outbound conversion

Tsukaima normalized output converts to OneBot segments.

| Tsukaima output | OneBot segment |
| --- | --- |
| text | `text` |
| image | `image` |
| sticker | `face` or `image`, depending on type |
| audio | `record` |
| video | `video` |
| mention | `at` |
| reply | `reply` plus target-dependent segments |

Long text may be split according to conversation policy. Sticker sending should be delayed until after text if it represents an emotional suffix.

## Rate limiting

Separate limits:

| Limit | Scope |
| --- | --- |
| messages per minute | conversation |
| messages per minute | channel |
| interactions per minute | conversation/user |
| group management per hour | conversation |
| media downloads per minute | channel |

Rate-limited actions are queued, not silently dropped, unless policy says otherwise.

## Health and diagnostics

Expose:

- connection state
- last connect/disconnect time
- reconnect attempts
- last event time
- last error class
- in-flight action count
- queued action count
- NapCat version/login info (non-sensitive)

Do not expose:

- access token
- QQ cookies
- full chat content in logs

## Operational cutover

1. Configure NapCat account-specific WebSocket server.
2. Keep DSH disconnected.
3. Configure Tsukaima's secret and outbound connection.
4. Start Tsukaima.
5. Verify health.
6. Verify fake/imported conversation rendering in WebUI.
7. Perform manual smoke test only when ready.

Do not run DSH and Tsukaima against NapCat simultaneously during cutover unless explicitly performing a supervised dual-connection test.
