# Tsukaima WebUI: Product and Interface Design

**Status:** implementation-ready design direction, 12 November 2026  
**Audience:** the next implementation session and reviewers  
**Scope:** the WebUI application shell, chat and session navigation, conversations, contacts, groups, requests, and entry points for system administration.

This document is self-contained. It records the agreed direction, distinguishes it from assumptions, and gives the implementing agent permission to resolve missing design details while implementing. The design is informed by QQ and Telegram workflows and uses [beUI](https://beui.dev/) as the visual and component system. It is not a claim that all described functions already exist.

## 1. Implementation brief

Build a practical messaging workspace, not a collection of admin cards. The application has three persistent structural regions:

1. A **global top bar**, spanning the full width of the window, for system-level operations.
2. A **left sidebar**, below the top bar, for chat objects and their sessions, users, groups, and requests.
3. A **content region**, alongside the sidebar and below the top bar, containing the router's `Outlet`. It displays a selected chat session or a system page.

The sidebar's Users, Groups, and Requests tabs are self-contained: their lists, detail views, and ordinary operations live in the sidebar. Switching among those tabs or drilling into a sidebar item must preserve the currently displayed content and chat state. Opening a related chat is an explicit navigation action and may change the content region. System actions in the top bar may open their pages in the content region.

The user has explicitly authorized the next implementation session to **fill in underspecified functionality and revise design details during implementation**. Inspect the then-current repository first; choose sensible defaults and keep moving. Document material deviations and unresolved product decisions. Ask only when a decision cannot reasonably be inferred or would be consequential and irreversible. Do not treat this document as a reason to stop work for routine design decisions.

This is a design document, not authorization to perform real external QQ actions during development. Develop and test with local or controlled fixtures; actual actions exposed in the product must make their target and result clear.

## 2. Established decisions

- The top bar is independent of both sidebar and content and spans across them.
- The sidebar begins with **Chats / Users / Groups / Requests** tabs. Use beUI **Tabs, `underline` variant**, rather than pill or segment tabs.
- The Chats tab contains chat objects; each chat object can contain multiple sessions, similar to projects and their conversations in ChatGPT. A session is selected from the sidebar and displayed in the content region.
- Users, groups and requests are sidebar workflows. Their details do not replace the content region merely because the user opens a list item.
- Divide the top bar, sidebar and content with simple straight one-pixel separators. Do not round the boundaries between the major panels or place them inside separate rounded cards.
- Other UI elements should retain beUI's rounded visual language: buttons, inputs, selected rows, avatars, popovers, message bubbles and composer controls may be rounded. Keep the result restrained, consistent and dense enough for daily messaging.
- Use [beUI AI Sidebar](https://beui.dev/components/agents/ai-sidebar) as a reference for compact hierarchical navigation, expansion and item actions. Preserve messaging semantics; do not automatically allow sessions to be dragged between unrelated chats just because the generic component supports tree moves.
- Use beUI for UI elements and styling. Compose or adapt its components for missing domain-specific behavior; do not introduce an unrelated design system. Use real beUI components and theme tokens in the implemented application rather than treating a mockup as an implementation.

## 3. Terminology and product model

| Term | Meaning in this design |
| --- | --- |
| Channel / account | The connection and account through which external events and messages are exchanged, such as a particular OneBot account. |
| Chat object | A stable communication scope, such as a QQ private chat, a QQ group, or a WebUI chat space. Its identity includes the channel/account and external peer or group identity when applicable. |
| Session | An Tsukaima conversation context under a chat object, with its own identity, title, lifecycle, message view and AI context. One chat object can have many sessions. |
| Message | A piece of platform, human, AI or system communication, retaining its origin, destination and relevant external identifiers. |
| User | A known person, bot or other identity. A user is not necessarily a friend; one user may have multiple external identities. |
| Request | A friend request, group join request or group invitation received from a supported channel, with a separately tracked processing state. |

These labels describe product concepts. Reuse existing repository terminology where appropriate, but preserve the distinctions in data and UI. Creating a new Tsukaima session must not imply creating a new QQ chat or group. Renaming, archiving or deleting an Tsukaima session must not imply modifying or deleting external QQ history.

### Working assumption: incoming external messages

The user has **not yet confirmed** how an external chat with multiple Tsukaima sessions should route new messages. For planning, the recommended default is one explicitly designated **receiving session** per external chat object. New external events attach to that session; changing the designation affects subsequent events and does not silently move prior messages. This is an Tsukaima product rule, not a OneBot capability.

Treat this as provisional rather than an approved requirement. While implementing, investigate existing durable-conversation behavior and choose a safe, explicit default compatible with the actual system. Preserve external messages and context, avoid duplicating or losing events, and document the final rule and migration. In-flight processing, replay, retries, imports and concurrent changes need defined behavior. Do not silently assume the selected session in the browser is automatically the receiving session. If no safe rule can be inferred without a consequential data decision, isolate that decision and ask a focused question after completing independent work.

## 4. Application shell

### 4.1 Global top bar

A single horizontal bar sits above both sidebar and content. At a 1440 px desktop viewport, start with approximately 56 px height; adjust to existing beUI tokens and real content. Use one horizontal separator below it.

- Left: Tsukaima identity and, where appropriate, a sidebar toggle.
- Right: Logs, Plugins, Settings, and an overflow/menu for theme and account actions.
- Logs open a resizable terminal-style bottom dock with the live ANSI stream, level
  filter, search, follow, and clear actions.
- Channel connection state belongs to the owning plugin page and the diagnostics route, not to a global top-bar indicator.
- System destinations are accessible independently of the sidebar tab and use the router's content outlet. Retain a clear way back to the last chat.
- A top-bar item opens a real route, menu or action. Do not present decorative controls as operational features.

### 4.2 Sidebar

Below the top bar, the desktop sidebar has a suggested starting width of 320 px, resizable approximately 280–400 px where practical. Its right boundary is a single vertical separator. The sidebar contains:

1. Underline tabs: Chats, Users, Groups, Requests. The request tab can show a pending count.
2. A search field scoped to the current tab, with an accessible label and useful placeholder.
3. Optional context-specific filters or actions.
4. A scrollable list or sidebar-local detail view.

Switching tabs preserves each tab's search, scroll position and selection where useful. Entering a detail view provides a clear back action; returning restores the list position. Sidebar details can scroll independently. Their layout should remain usable in the narrow sidebar; avoid forcing desktop-width tables into it.

The reference AI Sidebar provides a useful interaction pattern, not a fixed schema. Its tree movement, item kinds, icons and accessible controls must be adapted to chat semantics and supported operations. Do not imply a network-side mutation when merely reorganizing a local presentation.

### 4.3 Content and routing

Use the existing TanStack Router architecture: the root shell owns the layout; the content region renders the nested `Outlet`. Routes should be stable and deep-linkable for chat sessions and system destinations. Browser back/forward must recover the correct content and selected chat where feasible. Avoid hard-coding URLs before inspecting current route conventions.

A user/group/request sidebar selection alone does not navigate the outlet. An explicit **Open chat**, **Open session**, or equivalent action can navigate it. Provide a useful empty content state when no session has been selected. Keep sidebar and content scroll containers independent.

## 5. Sidebar: Chats

### Chat list

Show a compact list of chat objects ordered by most recent activity, with pinned chats first if pinning is implemented. Provide appropriate filters such as All, Unread and Archived where supported. Each parent row may show:

- avatar or fallback identity, display name, channel/account identification when needed;
- recent message preview and time if the data exists;
- unread, muted or pinned state when supported;
- expand/collapse and an accessible item-actions menu.

The parent identifies the chat; expanded children identify sessions. Avoid equating a user with their private chat: a user can exist without a corresponding chat object, and a group is a different scope.

Each child row shows its session title, updated time or activity, and meaningful state. Clearly label a receiving session if the product implements the provisional routing rule. The currently viewed session and the receiving session are separate states. Provide session creation and an action menu for supported rename, archive, restore and deletion operations. Make the scope and consequence of each operation explicit.

Clicking a child opens that session in the outlet. Define parent-row click versus expand behavior consistently, with separate accessible controls where necessary. Do not automatically transfer sessions between chat objects through drag-and-drop. Search should identify matching objects and sessions and reveal relevant parents without unexpectedly changing data.

Handle loading, empty lists, no search results, error/retry, offline and partial data. Avoid displaying invented unread counts or timestamps. Pagination or virtualization should be used if necessary for realistic list sizes without breaking keyboard navigation or focus.

## 6. Sidebar: Users

List known users and their relevant platform identity, searchable by known name, alias, remark or ID. Distinguish friends, non-friends and bots only where supported by actual data. Do not merge identities solely because display names match.

Selecting a user drills into a sidebar-local detail view with a back action. Include available display names, identifiers, relationship, remarks, linked private chat, shared groups and permitted actions. An explicit Open chat action selects or creates a chat only when supported; it is the action that navigates the content region. Do not replace the current session just by opening a user record.

Use skeleton/loading, no data, unavailable and retry states as appropriate. Identify when the channel is offline or a specific field cannot be retrieved instead of presenting stale or guessed data as authoritative.

## 7. Sidebar: Groups

List groups with name, ID, account and available member count or connection state. A group selection opens sidebar-local details, preserving the content region. Present group profile, members, associated chats/sessions, relevant events and available management actions using collapsible sections or sidebar-local subviews.

Group actions may include member mute, kick, card changes, group naming, administrator changes and leaving a group, but availability depends on the OneBot implementation, bot role and Tsukaima permissions. Clearly distinguish unsupported, insufficient permission, offline, pending, success, failure and unknown states. Show a reason for unavailable actions where useful. Actions affecting external users or groups require an appropriately scoped confirmation, a visible result and an audit trail. Do not present actions as working unless backed by a real capability.

## 8. Sidebar: Requests

Provide a request inbox with Pending and Processed views, plus filters for Friend, Group Join and Group Invitation where the data supports them. Show requester, target group where relevant, comment, time and processing state. Selecting an item opens a sidebar-local detail view, not a content page.

Support approve and reject only when the corresponding channel action is implemented and permitted. Show a reason field when relevant and supported. Clearly identify the requester and target, confirm external effects, prevent accidental duplicate submission, and display pending, succeeded, failed, timed out, expired or already handled elsewhere as known. Do not label a timeout as a confirmed failure: the remote action may have completed. Preserve the OneBot request flag and request subtype in the backend for correlation; do not expose implementation-only identifiers as the primary user-facing label.

A pending count represents pending requests, not ordinary unread messages. Request and notice events are distinct from ordinary conversation turns; they should not be silently treated as AI messages.

## 9. Session content

### Header and history

The content header identifies the chat object, session, channel/account and relevant status. Provide supported session actions and history search without duplicating global system controls. Message history should show sender, time, direction and delivery state as meaningful. Group messages need sender identity; external messages and AI output must remain distinguishable.

Render the supported message segments in order. Text, image and emoji/face are initial priorities, but keep the rendering extensible for reply, mention, audio, video, forwarded messages and platform-specific segments. Unsupported segments need a clear fallback; do not silently erase content. Associate recalls or updates with existing messages when supported. Long history needs efficient loading and stable scroll behavior; preserve position when loading older messages.

Use beUI's agent components for AI messages, streaming, activity, tool results and approvals where appropriate. Administrative events should not masquerade as user or AI messages.

### Composer and delivery

Keep a composer at the bottom of the session view. The user must be able to understand the destination before sending: for example, **send to QQ** versus **talk only to Tsukaima**, if both modes actually exist. The exact available modes must follow the actual backend and permission model; do not claim local-only behavior without isolation. Identify account and target when ambiguity is possible.

Show sending, confirmed success, failure and uncertain/timeout states; preserve drafts through navigation and disconnection where feasible. Avoid automatic retries that could duplicate an external send when the result is uncertain. Provide supported media and reply controls only when backed by capabilities. Explicitly handle read-only or disconnected sessions.

## 10. beUI visual language and components

Use the project's existing theme tokens and beUI source where appropriate. Consult the current beUI registry and component documentation when implementing, since the library may have evolved. Reuse components already present in the repository after checking their APIs and behavior.

| Purpose | beUI starting point |
| --- | --- |
| Sidebar shell and hierarchical list | Animated Sidebar, AI Sidebar, Collapsible |
| Main sidebar navigation | Tabs with `underline` variant |
| Search and inputs | Input, Combobox where appropriate |
| Session display | Chat App, Message, Message Bubble, Message Scroller, Prompt Input |
| AI progress and approvals | Streaming Response, Agent Activity, Tool Result, Approval Card |
| Contextual actions | Context Menu, Popover, Button |
| Confirmation and feedback | Morphing Modal, Alert, Animated Toast Stack, Loader |
| Settings | Switch, Select, Checkbox, Radio Group, Theme Toggle |

The top-level panels meet along straight separators; their boundaries have no rounded corners. Rounded controls and surfaces within them should look native to beUI. Avoid unnecessary wrapper cards and excessive visual chrome. Use light and dark themes with legible contrast. Prefer brief, purposeful motion, respect reduced-motion settings, and avoid animating large lists on every update.

### Color palette

The palette is warm paper under charcoal ink, with mist gray-blue as the single accent. Tokens
live in `apps/web/src/app.css`; components must use the tokens rather than raw hex values.

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Primary (ink) | `--primary` | `#292c30` | `#90a1ae` |
| On primary | `--primary-foreground` | `#f6f4f0` | `#16181b` |
| Page background | `--background` | `#f6f4f0` | `#1b1e22` |
| Card / raised surface | `--card` | `#fbfaf7` | `#23272b` |
| Sidebar | `--sidebar` | `#f1eee8` | `#16181b` |
| Muted surface | `--muted` | `#efece6` | `#2b3036` |
| Text | `--foreground` | `#292c30` | `#f2efe9` |
| Secondary text | `--muted-foreground` | `#6b6760` | `#a3abb2` |
| Accent fill | `--accent` | `#90a1ae` | `#a7b5c0` |
| Accent text / focus | `--ring` | `#5c7285` | `#90a1ae` |
| Danger | `--danger` | `#b4453c` | `#e0796f` |
| Success | `--success` | `#47735a` | `#7fb39a` |
| Warning | `--warning` | `#8a6415` | `#d9ae62` |

Notes:

- Charcoal is the light-theme primary; in dark mode mist takes over as the primary so controls stay
  visible against charcoal surfaces. Light-mode accent text uses the deeper mist tone because
  `#90a1ae` alone is only 2.4:1 on cream.
- Status colors are darkened in light mode and lightened in dark mode so each pair clears 4.5:1 on
  its surface. Pair them with a label or icon, never color alone.
- The context-window breakdown uses the `--chart-*` tokens (messages, tools, persona, policy,
  memories, other, buffer, deferred, free) instead of ad-hoc palette classes.
- The log terminal has its own `--log-bg` surface and pairs `github-light-high-contrast` with
  `github-dark-high-contrast` for ANSI token colors.

## 11. Responsive behavior and accessibility

- Desktop: global top bar above a persistent sidebar and flexible outlet.
- Medium widths: reduce or collapse sidebar width without compromising controls or text.
- Narrow widths: keep the global top bar; navigate between sidebar and content as single-column views with a clear Back action. Users/groups/requests remain sidebar navigation, not outlet pages. Preserve the active session when navigating back and forth.
- Support keyboard navigation, clear focus, accessible names for icon-only controls, proper tab semantics and arrow-key behavior, and Escape for dismissible overlays. Make row actions available without hover and usable on touch.
- Pair status colors with labels/icons. Respect reduced motion. Maintain readable sizes and contrast rather than shrinking a desktop interface onto a phone.
- Localize new user-visible text through the project's existing i18n workflow; account for longer translations and support the project's existing languages.

## 12. Data, backend and integration requirements

The interface needs real data and honest capability states. Inspect actual code and tests at implementation time before designing contracts. In particular:

- Model the stable chat object separately from multiple sessions, including channel/account scope. Preserve existing records and external identity during migrations. Consider uniqueness, nullable external IDs, backfill and rollback/recovery.
- Define when a message is ingested, deduplicated, assigned to a session, displayed, read and sent. Preserve original platform IDs and channel identity. Determine how session switching interacts with in-flight processing and existing durable context.
- Add or adapt typed APIs for chat/session lists and operations, message history and delivery, user/group lookup, requests and live updates as needed. Read-only, unsupported and not-yet-configured states must be explicit.
- The server and adapter must represent real connection state. Object existence alone is not proof of an active WebSocket.
- OneBot v11 and implementations differ. Check supported actions, permissions and account roles at runtime when possible. NapCat extensions must not be presented as universal OneBot APIs. Never expose sensitive credentials in the UI or diagnostics.
- Persist and correlate request events and their actions; treat ambiguous timeouts and retries carefully. Distinguish external authorization from UI permissions.
- Ensure real-time updates do not discard local draft text, sidebar context or the reader's scroll position.

## 13. Current repository snapshot (verify again before implementation)

At the time of this design review:

- `apps/web/src/routes/__root.tsx` renders `AdminShell` around the root `Outlet`; `apps/web/src/admin-shell.tsx` currently puts system navigation and child content inside an Animated Sidebar composition. The shell needs restructuring to meet the agreed region boundaries.
- `apps/web/src/pages/conversation-page.tsx` displays the results of `conversations.list`; it is not yet a complete session/message interface.
- `apps/web/src/components/agents/` and `apps/web/src/components/motion/` already contain a substantial set of beUI-derived components, including AI Sidebar, Tabs and chat primitives. The application uses React, Tailwind CSS 4, Motion and TanStack Router.
- `packages/db/src/schema.ts` includes users, identities, conversations and messages. Its current uniqueness constraint on channel and platform conversation ID does not itself provide the proposed chat-object-to-many-sessions model. Do not assume the model already exists.
- `plugins/onebot-napcat/src/protocol/channel.ts` has a WebSocket channel, action correlation and private/group sending. `plugins/onebot-napcat/src/protocol/normalize.ts` currently normalizes private and group message events and selected segments; it is not a complete implementation of the request and notice workflows. `docs/architecture/onebot.md` describes broader intended capabilities and must not be mistaken for evidence that they are all implemented.
- `apps/server/src/rpc/admin.ts` includes basic conversation listing, settings, policies, plugins and diagnostics. Its `onebotConnected` field currently checks whether a channel object exists; it does not by itself establish that the transport is connected.
- Repository state can change between sessions. Preserve any user or other-agent changes, and use the actual current source as the authority.

## 14. Suggested implementation sequence

The order can change to suit what the repository reveals; the objective is a coherent working product rather than a static shell.

1. Inspect existing route structure, component APIs, durable conversations, schemas, migrations and OneBot behavior. Decide and document safe session and message ownership semantics.
2. Implement the shell: global top bar, independent sidebar and outlet, underline tab navigation, straight panel separators, responsive layout and basic empty/error states.
3. Connect chat objects and their sessions to real data; implement selection, session history, message rendering and supported sending with explicit targets.
4. Add sidebar-local user and group views, available details and capability-aware actions.
5. Add request ingestion, persistence and processing, including correct state and failure handling.
6. Complete search, unread state, archives, realtime updates, accessibility, localization and media support as backed by the system. Revisit earlier design decisions whenever actual implementation reveals a better fit.

## 15. Acceptance and verification

Verify against actual behavior, not only a screenshot:

- The global top bar spans sidebar and content; panel seams are straight; controls retain beUI-style rounding; sidebar tabs use the underline variant.
- One chat object visibly contains multiple distinct sessions. Selecting sessions changes the outlet; opening user/group/request details does not. Sidebar tab switches preserve the active content.
- Browser navigation, independent scrolling, sidebar back navigation and narrow-screen navigation remain coherent.
- Contact/group/request actions reflect real capability, permissions and transport state. External side effects clearly identify their target, confirmation and outcome. Timeouts do not falsely imply failure or invite unsafe duplicate sends.
- Existing records survive migrations; incoming external messages are not silently lost or duplicated; chat/session routing behavior is explicit and testable.
- Loading, empty, error, offline and unsupported states are understandable. No fake data is shipped as live data.
- Keyboard, accessible labels, focus, reduced motion, light/dark themes and localization work in the implemented components.
- Run relevant repository checks and meaningful tests for changed behavior. Add focused tests for data migrations, message/session association, routing, request state transitions and other consequential paths. Verify the actual rendered UI at desktop and narrow widths when tooling permits.

## 16. References

- [beUI registry](https://beui.dev/r), [theme setup](https://beui.dev/docs/theme), [AI Sidebar](https://beui.dev/components/agents/ai-sidebar), [Tabs](https://beui.dev/components/motion/tabs), [agent components](https://beui.dev/docs/ai-agents)
- [OneBot v11 public API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md), [request events](https://github.com/botuniverse/onebot-11/blob/master/event/request.md)
- [Telegram chat folders and archive](https://telegram.org/blog/folders)
- Existing project architecture: `docs/architecture/onebot.md` and other current repository documentation.
