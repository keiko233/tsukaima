# Runtime logging

Tsukaima uses one structured logger for console output and WebUI diagnostics. The implementation is in `apps/server/src/logging.ts`.

## Record model

Every entry contains:

- a monotonically increasing buffer ID;
- an ISO-8601 UTC timestamp;
- `debug`, `info`, `warn`, or `error` level;
- a Rust-style target such as `tsukaima::server::lifecycle`;
- a single-line message;
- redacted, JSON-safe fields;
- an optional span name and span fields;
- plain and ANSI-rendered tracing lines.

The rendered format follows Rust `tracing_subscriber::fmt`:

```text
2026-11-12T13:08:24.886Z  INFO process_message{channelId="onebot"}:
  tsukaima::server::lifecycle: channel message processed sessionId="..."
```

The WebUI uses the ANSI line, so the same output is colored in the browser as in a terminal.

## Safety and retention

- Values are normalized, depth-limited, and truncated.
- Newlines and control characters are escaped, including terminal escape sequences.
- Field keys matching API keys, tokens, secrets, passwords, authorization, or cookies are redacted.
- Message content and raw channel payloads are not logged by the lifecycle.
- The process keeps the latest 2,000 entries in memory. The buffer is intentionally diagnostic, not an audit store or durable log archive; process restart clears it.

## Transports

- Console: human-readable tracing output. ANSI is used only when the output stream is a TTY and color is not disabled.
- Diagnostics RPC: `admin/diagnostics/logs` returns a snapshot and supports `afterId`, `level`, and `limit` filters.
- Clear RPC: `admin/diagnostics/clearLogs` empties the in-memory buffer.
- Realtime: `GET /events/logs` is a server-sent event stream. It sends a `snapshot` event, then `log` events, with periodic `heartbeat` events for idle connections.
- WebUI: the Diagnostics page consumes the RPC snapshot and SSE stream, filters entries locally, and renders ANSI with Shiki's `ansi` language.

The stream is LAN-admin-only under the current deployment model. It requires a live Better Auth
administrator session, resolved from the same request cookie as the rest of the WebUI.
