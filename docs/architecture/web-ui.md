# WebUI

The WebUI is IM-first. It is the administrator console and diagnostic surface, not a separate agent product.

## Layout

- Left: conversation list, grouped by channel and type.
- Center: message stream with multi-sender bubbles, images, stickers, replies, recalls, tool cards, and task cards.
- Right: context panel with persona, memory, model route, active tasks, plugin panels, and channel details.
- Top: search, filters, channel status, and account health.
- Admin route: plugins, permissions, personas, memory review, deployment proposals, migration reports.

## Message behavior

- Show raw activity members even when they are aggregated into one model turn.
- Mark aggregated ranges.
- Preserve replies, mentions, recalls, and stickers.
- Render durable task progress from the conversation view.
- Tool calls are first-class cards, not hidden logs.
- Plugin UI embeds into side panels and message cards through a typed bridge.

## API

Bun HTTP/WebSocket API provides:

- authenticated admin session
- conversation list/stream/history
- durable watch streams
- task graph and task details
- memory search/review
- plugin registry and manifests
- policy edit and audit
- migration dry-run/report
- deployment proposals

There is one administrator in the first release. All state-changing routes require auth and audit. The WebUI never exposes raw secrets.
