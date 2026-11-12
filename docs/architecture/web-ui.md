# WebUI

The WebUI is an IM-first administrator workspace. It uses the existing beUI-derived
components, Tailwind theme tokens, TanStack Router, and TanStack Query.

## Routing and module layout

TanStack Router generates `src/route-tree.gen.ts`. Routes are organized by pathless
route groups:

```text
routes/
  (messaging)/
    index.tsx
    chat.$sessionId.tsx
    _modules/
  (system)/
    diagnostics.tsx
    plugins.tsx
    policies.tsx
    settings.tsx
    _modules/
  _modules/
    shell/
    ui/
    lib/
    hooks/
```

- `(messaging)` owns the empty content state and deep-linkable chat session route.
- `(system)` owns plugins, settings, model policies, and diagnostics.
- Components, hooks, and helpers used by only one route group live under that group's
  `_modules` directory. Shared shell modules live under `routes/_modules`.
- `_modules` is ignored by the router generator and must not contain route files.

The root route owns the global shell and the nested `Outlet`.

## Layout

- A 56 px global top bar spans the full window and contains the Tsukaima identity,
  connection state, plugins, settings, the overflow menu, and the theme toggle.
- The sidebar sits below the top bar and is independently resizable from 280–420 px.
  Its right border is a straight one-pixel separator.
- The content region is the router outlet. Panel boundaries are not rounded; controls
  inside them keep beUI's rounded style.
- On narrow screens the top bar remains, while sidebar and content render as a
  single-column pair with an explicit Back action.

## Sidebar

Underline tabs switch between Chats, Users, Groups, and Requests. Each panel remains
mounted so search text and scroll position survive tab switches. The Requests tab shows
the pending request count.

### Chats

The Chats panel organizes stable chat objects above their Tsukaima sessions.

- Expanding a chat object reveals its sessions without changing the content route.
- Selecting a child navigates to `/chat/$sessionId`.
- Session actions support open, rename, archive/restore, create another session, and
  designate a receiving session.
- A receiving badge identifies the session used for subsequent external messages. The
  selected browser session and receiving session are separate states.
- Drag-and-drop between chat objects is intentionally not supported.
- Creating a local chat creates a WebUI chat object and session only. It does not create
  an external QQ chat.

### Users, Groups, and Requests

Selecting a row opens a sidebar-local detail view with a Back action. These views do
not navigate the content outlet.

- Users show canonical identities, aliases, trust/notes, linked private chats, and shared
  groups. Opening a linked chat is an explicit navigation action.
- Groups show known members, sessions, and profile identifiers. Group management is
  shown as unavailable until a real permission-aware action surface exists.
- Requests show pending or processed events with requester, target group, comment, and
  state. Approve/reject is enabled only while the channel is connected. Confirmation
  names the external target, and timeouts remain visibly uncertain.

## Chat content

The session header identifies the chat object, session, channel, receiving state, and
channel connection state. Archived sessions are read-only.

The transcript renders persisted inbound/outbound messages and durable assistant
entries. Text, image, and sticker metadata are shown with explicit fallbacks for
unsupported content. Delivery state is shown for self-authored messages.

The composer offers only capabilities that currently exist:

- **Talk to Tsukaima** appends a WebUI envelope to the selected session and starts an
  Tsukaima turn.
- **Send to channel** is available for external private/group sessions only while the
  OneBot WebSocket is connected. It sends directly to the external target without
  asking Tsukaima to reply.

Drafts are stored per session in local storage. A failed or uncertain external send is
not retried automatically.

## Data and RPC

The WebUI uses real domain data and durable transcript entries:

- `admin/chats/*` for chat objects and local chat creation.
- `admin/sessions/*` for session metadata, transcript reads, messages, and session
  lifecycle.
- `admin/users/*` and `admin/groups/*` for directory views.
- `admin/requests/*` for request review and decisions.
- `admin/diagnostics/status` for the real transport state and runtime diagnostics.
- `admin/settings/models` for server-side discovery through an OpenAI-compatible
  provider's `/models` endpoint. The browser never receives the provider API key.

No unread, unconfigured, or unsupported action is represented as working. Missing
transport capabilities are disabled with an explanation.

## Localization

Paraglide compiles the `en` and `zh-cn` message files under `apps/web/messages`. The
Settings page exposes the available interface languages and stores the choice in the
browser's local storage. Changing it reloads the document so every route and shell
component resolves messages in the selected locale. The startup locale is also written
to the document's `lang` attribute. This is a browser preference and does not modify
the server-side runtime settings shared by the deployment.

## Message routing

See ADR 0007. New external messages go only to the active receiving session of their
chat object. The receiving designation affects future messages only. Deduplication uses
both a durable receipt and `(chat_object_id, platform_message_id)`.

Activity windows flush after six seconds of inactivity. Windows that were collecting at
shutdown are resumed after restart, so a single external message can still produce a
turn without waiting for another message.

## Known limitations

- Model responses generated from external channel messages are visible in the WebUI but
  are not yet automatically sent back through OneBot.
- Chat-list previews use indexed domain messages. An assistant-only latest turn may not
  appear as the parent preview until another indexed message arrives.
- OneBot implementations differ in group-management and request behavior. The UI only
  advertises friend/group request decisions exposed by the current channel facade.
- There is no unread-count schema yet, so the UI does not invent one.
