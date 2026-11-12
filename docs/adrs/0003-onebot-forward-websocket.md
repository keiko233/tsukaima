# ADR 0003: Tsukaima actively connects to NapCat WebSocket

## Status

Accepted

## Context

The current DSH bridge uses outbound WebSocket to NapCat. Reverse WebSocket is common in frameworks such as AstrBot, but the first deployment should preserve the known working topology and simplify cutover.

## Decision

The first release uses NapCat as the WebSocket server and Tsukaima as the outbound WebSocket client. Reverse WS support can be added later as another channel transport.

## Requirements

- Account-specific NapCat config is used, not a generic template.
- Connection authentication uses a secret; it is never logged or committed.
- Reconnect with exponential backoff and jitter.
- Duplicate event IDs are idempotently discarded.
- Action requests correlate echo IDs to durable action records.
- HTTP is used for API calls when appropriate, while WebSocket remains the primary event/control channel.
- Credential-reading capabilities are disabled or require explicit audit.
