# KV cache

Elaina uses a small Redis-like key/value layer for ephemeral state that must be shared by the
server, the WebUI event stream, and plugins. The layer is built on **Keyv**, with SQLite as the
durable adapter and a process-local bus/stream companion.

The package is `@elaina/cache` (`packages/cache`). It is infrastructure, not domain storage:
durable conversations/tasks remain in `pi-durable`, and domain records remain in Drizzle.

## Why Keyv

- One storage contract (`get`, `set`, `delete`, TTL) instead of a hand-written table API.
- TTL is part of the contract, which is what most ephemeral state needs.
- The official SQLite adapter has a `bun:sqlite` driver, so the host needs no native fallback.
- In-memory mode makes unit tests and embedders trivial.
- Keyv does **not** provide pub/sub or streams. Those are the two small pieces this package
  adds; they are deliberately not reinvented as a second cache.

## Layers

```text
@elaina/cache
  KeyvCache      Keyv + @keyv/sqlite, logical namespaces, stats, per-key locks
  CacheBus       process-local exact/prefix pub/sub for live consumers
  CacheStream    bounded append-only log (`seq`, `atMs`, `value`) on one Keyv key
```

The cache file is `data/cache.sqlite`; its table is `elaina_cache`. It is separate from
`domain.sqlite` and `durable.sqlite` so cache growth, expiry, and corruption never affect the
source of truth.

## Key namespaces

| Key | Value | TTL |
| --- | --- | --- |
| `run.state.<sessionId>` | latest `LiveRunState` | 30 min |
| `run.final.<entryId>` | final `RunStep[]` process chain | 7 days |
| `stream:run.<sessionId>.events` | bounded `LiveRunPatch` history | 30 min |
| `plugin:<pluginId>:<key>` | plugin cache value | plugin-selected |

A browser keys live state by **domain session id**. The core host reports live runs by durable
conversation id, so the lifecycle resolves one to the other before writing the cache.

## Live streaming

The durable `pi.live` document remains the source of truth for a run, but the WebUI no longer
polls it directly.

```text
pi-durable pi.live ──(100ms committed snapshot)──> LiveRunCache
                                                     │
                         ┌───────────────────────────┼───────────────────────────┐
                         ▼                           ▼                           ▼
                 run.state.<session>        stream:run.<session>.events     CacheBus "run"
                 (reconnect snapshot)       (replay / debugging)            (live SSE deltas)
```

1. The core host observes a committed live snapshot.
2. `LiveRunCache` compares it with the previous state in `#last`.
3. It writes the full state to `run.state.<sessionId>` so a reconnecting browser needs one read,
   not a durable poll.
4. It appends a patch containing only changed fields to a bounded stream.
5. It publishes one bus event. Every SSE subscriber sends a `run.delta` frame.

A newly connected browser subscribes to the bus first, then reads `run.state.*` snapshots. A
`revision` number orders a snapshot against a delta that landed in between, so the client never
rewinds.

`liveRunState.phase` gives the UI a status before the first token:

- `queued`: run admitted, the model request has not produced content yet
- `retry`: the run is waiting out the provider's backoff before the next attempt
- `thinking`: reasoning is streaming
- `tool_calls`: the model is still emitting a tool call's arguments
- `writing`: answer text is streaming
- `tools`: at least one tool is pending or running
- `settled`: the run ended

The state also carries the pieces a complete call flow needs: `attempt`, `model`, `retry`,
`draftTools` (calls the model is still emitting), and `steps` (finished model calls, reasoning,
and tool calls). `LiveRunCache` builds `steps` with a `LiveRunTimeline`, so a tool round does not
erase the reasoning that produced it and a new model request does not erase the previous round's
tools. Current-round partials stay in `partialText`, `partialThinking`, and `tools`, which keeps
the high-frequency text commit small.

The OpenAI-compatible provider streams SSE deltas instead of buffering the full completion and
replaying it. A provider that ignores `stream: true` and answers with JSON still works through
the same event stream. That is what makes `thinking`/`writing` arrive while the model is actually
producing them rather than after the request has already completed.

### Reconnect and expiry

A run that outlives the 30-minute state TTL is stale by definition; the next live snapshot
rewrites it. A settled run is not returned by `snapshots()`, so a new browser does not render a
phantom activity row.

### Final process chain

`pi.live` is cleared when a run settles, and some providers do not copy reasoning into the
durable assistant entry. When the durable answer arrives, `LiveRunCache.finalizeAnswer()` stores
the last non-empty run state as `run.final.<entryId>`. Its `steps` come from the same timeline, so
the cached chain includes every model call and tool round, not only the final partial.

`admin.sessions.runSteps` reads the durable transcript first, then falls back to that final
process chain. If the durable entries have no reasoning, cached thinking steps are prepended.
This keeps the thinking/tool chain visible after the answer lands.

## Plugins

Plugins receive `context.cache` only when their manifest grants a `cache.*` permission:

| Permission | Capability |
| --- | --- |
| `cache.read` | `get`, `has`, `getOrSet` read side, `subscribe` |
| `cache.write` | `set`, `delete`, `getOrSet` write side |
| `cache.publish` | `publish` |

Keys are automatically prefixed with `plugin:<pluginId>:`, and channels with
`plugin.<pluginId>.`, so one plugin cannot read, clear, or notify another plugin's namespace.

```ts
async setup(context) {
  const cached = await context.cache?.get<Snapshot>("snapshot:1");
  if (cached !== undefined) return cached;

  const value = await context.cache?.getOrSet(
    "snapshot:1",
    async () => fetchSnapshot(),
    { ttlMs: 5 * 60_000 },
  );
  await context.cache?.publish("snapshots", { id: 1 });
}
```

`cache.subscribe` is host-mode only. Worker plugins receive the same value operations through
host-mediated calls, but no in-worker subscription callback, because the worker boundary is
request/response. Use a host-mode plugin when a plugin needs push notifications.

Plugin cache is not a replacement for `context.storage`: use storage for durable, non-expiring
plugin data that must survive a cache flush; use cache for TTL state, cooldowns, cursors, and
invalidation signals.

## Diagnostics

`admin.diagnostics.status` includes cache counters (`gets`, `hits`, `misses`, `sets`, `deletes`,
`publishes`, `streamAppends`) and the WebUI diagnostics page renders them. Failures are logged
through the lifecycle warning path and never fail message processing.

## Failure behavior

- A cache read failure is logged; live state is presentation, not the answer path.
- A cache write failure does not block a run. The next snapshot retries the state write.
- The cache is closed during lifecycle shutdown after the conversation host stops.
- No cache value is treated as authoritative over `pi-durable` or the domain database.

## Tests

- `packages/cache/tests/cache.test.ts`: TTL, namespaces, persistence, locking, bus, streams.
- `apps/server/tests/live-run-cache.test.ts`: deltas, reconnect snapshots, per-round call chain,
  retries, final process chain.
- `apps/server/tests/plugin-cache.test.ts`: plugin namespacing and permissions.
- `apps/server/tests/event-stream.test.ts`: live `run.delta` streaming over SSE.
