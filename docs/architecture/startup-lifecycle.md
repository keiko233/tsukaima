# Startup lifecycle

Tsukaima performs migrations and dependency preparation as part of application startup. The HTTP server does not accept traffic until the required boot stages complete.

## Principles

1. Startup is idempotent.
2. Migrations run before channels, agents, plugins, or WebUI are marked ready.
3. A migration failure fails startup loudly; the process must not serve partial state.
4. No user message is accepted before the conversation store is ready.
5. Background jobs do not run until their storage is ready.
6. Shutdown is ordered and waits for active work to reach a safe checkpoint where possible.

## Startup stages

```text
1. Load and validate configuration
2. Prepare logging, request IDs, telemetry
3. Open durable.sqlite and run durable migrations
4. Open domain.sqlite and run Drizzle migrations
5. Verify blob storage
6. Load model policies and initialize model router
7. Initialize durable Harness/runtime
8. Load plugin manifests and registry state
9. Start plugin workers (enabled only)
10. Initialize domain services
11. Start scheduler and background task recovery
12. Bind HTTP/WebSocket server
13. Start channel adapters
14. Mark process healthy
```

Stage 12 binds the listener, but readiness is false until stage 13 succeeds. Health checks should distinguish `listening` from `ready`.

## Stage details

### 1. Configuration

- Read environment and mounted files.
- Validate with Zod.
- Resolve data paths, database paths, blob directory, secret references, model policy file path, and plugin directories.
- Fail fast on missing required values.

No secret value is logged.

### 2. Logging and telemetry

Initialize structured logging and request context before any database operation. Startup logs should include stage, duration, schema versions, and errors, but not content.

### 3. Durable database

Open `data/durable.sqlite` with `BunSqliteStorage`.

Steps:

1. Ensure parent directory exists.
2. Open SQLite in write mode.
3. Configure WAL, synchronous mode, and busy timeout.
4. Call `SqliteStorage.open`.
5. Let `pi-durable` run/create its schema migrations.
6. Record resulting schema version in startup diagnostics.

If migration fails, close the database and stop startup.

### 4. Domain database

Open `data/domain.sqlite` with Drizzle.

Steps:

1. Ensure parent directory exists.
2. Open SQLite.
3. Acquire an application-level startup lock.
4. Run `drizzle-kit`-generated migrations through the bundled migration runner.
5. Record the applied schema version.
6. Release the lock.

The migration runner must be embedded in the app startup path, not left as a manual deployment command. A separate CLI may exist for development, but production startup is authoritative.

Migration rules:

- run migrations synchronously during boot
- use an exclusive startup lock to avoid two instances migrating at once
- store applied versions in Drizzle's migration table
- do not run destructive migrations automatically unless their migration is explicitly marked safe for startup
- if a destructive migration is required, startup fails with a clear maintenance-mode message unless an explicit environment flag confirms it

### 5. Blob storage

Verify:

- directory exists or can be created
- permissions are correct
- disk has the configured minimum free space

Create subdirectories lazily, but verify the root before serving.

### 6. Model router

1. Load model policy records from domain DB.
2. Validate policy references.
3. Register providers through `pi-ai`.
4. Verify Magpie reachability if configured as required.

Magpie being temporarily unreachable can make the server `degraded`, not automatically `failed`, but startup must record it. Channels should not accept chat submissions if no usable chat model policy exists.

### 7. Durable runtime

Initialize the `pi-durable` Harness after durable storage is ready.

- open the storage
- initialize registry
- verify conversation document definitions
- do not call `resume()` before scheduler is intentionally started

### 8. Plugin registry

1. Scan configured plugin directories.
2. Parse manifests with Zod.
3. Compare with domain plugin registry.
4. Register known enabled plugins.
5. Do not execute plugin code during manifest validation.

Missing plugin files for an enabled plugin mark that plugin failed; startup continues unless the plugin is marked critical.

### 9. Plugin workers

For enabled plugins:

1. Start host-mode plugin in the main process.
2. Start worker-mode plugin in a plugin worker.
3. Apply permission grants.
4. Wait for `setup()` completion within a timeout.
5. Record plugin status.

A non-critical plugin failure does not fail startup. A critical plugin failure must fail startup according to registry policy.

### 10. Domain services

Construct services with opened database handles and the durable runtime:

- conversation service
- user service
- memory service
- persona service
- policy service
- media service
- audit service
- plugin service
- model router

Services must not perform ad-hoc migrations.

### 11. Scheduler and recovery

Start the durable task scheduler and call recovery/resume for work interrupted by a previous process.

- resume unfinished durable tasks
- resume sleeping tasks whose deadlines passed
- mark crashed runs according to durable semantics
- emit recovery diagnostics

### 12. HTTP/WebSocket

Bind Elysia and mount:

- `/healthz`
- `/readyz`
- `/rpc/*`
- static WebUI assets
- auth routes, if separate from RPC

`/healthz` may return 200 for a listening process. `/readyz` returns 200 only after channels are ready.

### 13. Channels

Start channel adapters in order:

1. fake channel in tests/dev, if enabled
2. OneBot/NapCat outbound WebSocket, if configured

OneBot readiness requires:

- authenticated WebSocket connection
- `get_login_info` succeeded
- account ID matches configuration
- event subscription is active

If OneBot is configured but cannot connect, startup may finish `degraded` or `failed` depending on policy. The default for production should be `failed` so the process restarts through normal service supervision.

### 14. Ready

When all required stages pass:

- set readiness true
- publish startup summary
- begin accepting RPC mutations
- begin accepting channel events

## Health states

| State | Meaning |
| --- | --- |
| `starting` | Boot sequence is running |
| `degraded` | Required storage is ready; optional dependency failed |
| `ready` | Required stages passed; traffic accepted |
| `maintenance` | Database/schema requires manual action |
| `failed` | Required stage failed; process exits |

`/healthz` reports state and stage history. `/readyz` returns 204 only for `ready` (or `degraded` only if explicitly configured to accept chat traffic without optional dependencies).

## Readiness checks

`/readyz` verifies:

1. both database handles are open
2. durable schema is current
3. domain schema is current
4. blob root is writable
5. at least one usable chat model policy exists
6. required plugins are loaded
7. required channels are connected
8. scheduler is running

Failures include stable reason codes.

## Concurrent instances

Only one writer process should open each SQLite database for normal operation.

The startup lock prevents concurrent migration, but it does not make two full server instances safe. Deployment tooling must ensure single active instance. If HA is added later, it requires explicit storage/process coordination.

## Maintenance mode

If startup detects:

- pending destructive migration
- incompatible durable schema
- missing critical plugin
- invalid configuration

It should:

1. stop before channels
2. bind only health endpoints, if possible
3. return a maintenance reason
4. exit nonzero under service supervision, or remain in maintenance mode based on configuration

## Shutdown lifecycle

```text
1. Stop accepting new RPC traffic
2. Stop channel adapters
3. Drain in-flight agent submissions where policy allows
4. Cancel/stop plugin hooks and workers
5. Stop scheduler
6. Flush audit/log buffers
7. Close durable runtime
8. Close domain database
9. Close blob storage handles
10. Exit
```

Shutdown has a configurable deadline. When it expires:

- abort active tasks through durable APIs where possible
- stop workers
- close databases
- exit nonzero if work could not finish

OneBot shutdown should close the WebSocket before databases close so no outbound action races a closed runtime.

The process owns `SIGINT` and `SIGTERM`, so it must terminate itself: after the graceful
sequence completes, exit explicitly instead of waiting for the event loop to drain.
`bun --watch` keeps the loop alive, and a pending reconnect timer can also hold it, so a
handler that only `await`s cleanup leaves the process running after Ctrl+C.
