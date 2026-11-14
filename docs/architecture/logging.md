# Runtime logging

Elaina uses one structured logger for console output and WebUI diagnostics. The implementation is in `apps/server/src/logging.ts`.

## Record model

Every entry contains:

- a monotonically increasing buffer ID;
- an ISO-8601 UTC timestamp;
- `trace`, `debug`, `info`, `warn`, or `error` level;
- a Rust-style target such as `elaina::server::lifecycle` or `elaina::plugin::<pluginId>`;
- a single-line message;
- redacted, JSON-safe fields;
- an optional span name and span fields;
- plain and ANSI-rendered tracing lines.

The rendered format follows Rust `tracing_subscriber::fmt`:

```text
2026-11-12T13:08:24.886Z  INFO process_message{channelId="onebot"}:
  elaina::server::lifecycle: channel message processed sessionId="..."
```

The WebUI uses the ANSI line, so the same output is colored in the browser as in a terminal.

## Safety and retention

- Values are normalized, depth-limited, and truncated.
- Newlines and control characters are escaped, including terminal escape sequences.
- Field keys matching API keys, tokens, secrets, passwords, authorization, or cookies are redacted across all levels.
- `debug` logs operational metadata (counts, timings, status codes, cache hits) without message text; `trace` logs include bounded single-line text previews (`previewText`, 120 chars) while preserving secret redaction.
- The in-memory buffer retains the latest 5,000 entries by default (configurable via `ELAINA_LOG_BUFFER_CAPACITY`).
- Daily date-chunked file logs are written to `<ELAINA_DATA_DIR>/logs/elaina-YYYY-MM-DD.log` by default (configurable via `ELAINA_LOG_FILE_ENABLED`, `ELAINA_LOG_DIR`, and `ELAINA_LOG_RETENTION_DAYS`).
- When `ELAINA_LOG_LEVEL` is explicitly set in the environment, it overrides persisted database runtime settings on startup; runtime changes made in WebUI Settings take effect immediately.

## Transports

- Console: human-readable tracing output. ANSI is used only when the output stream is a TTY and color is not disabled.
- File sink: plain tracing lines written to daily date-chunked log files (`elaina-YYYY-MM-DD.log`).
- Diagnostics RPC: `admin/diagnostics/logs` returns a snapshot and supports `afterId`, `level`, and `limit` filters.
- Clear RPC: `admin/diagnostics/clearLogs` empties the in-memory buffer.
- Realtime: `GET /events/logs` is a server-sent event stream. It sends a `snapshot` event, then `log` events, with periodic `heartbeat` events for idle connections.
- WebUI: the Diagnostics page consumes the RPC snapshot and SSE stream, filters entries locally, and renders ANSI with Shiki's `ansi` language.

The stream is LAN-admin-only under the current deployment model. It requires a live Better Auth
administrator session, resolved from the same request cookie as the rest of the WebUI.
