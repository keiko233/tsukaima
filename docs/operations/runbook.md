# Production runbook

This runbook is the operator-facing companion to the architecture documents. It covers the
release-readiness items: deployment prerequisites, secret configuration, NapCat connectivity,
health checks, the offline DSH migration workflow, scheduled backup/restore drills, and supervised
self-iteration reload recovery.

Related documents:

- [Startup lifecycle](../architecture/startup-lifecycle.md)
- [DSH migration](../migration/dsh.md) and [Migration Kit](../migration/migration-kit.md)
- [Quality gates](quality.md)
- [Project state](../project-state.md)

## 1. Deployment prerequisites

| Requirement | Notes |
| --- | --- |
| Bun `1.4.4` | Runtime for the server, plugins, and tools. |
| Single writer process | Only one server may open `domain.sqlite` and `durable.sqlite` for writes. |
| Writable data directory | `TSUKAIMA_DATA_DIR` holds both databases, `blobs/`, plugin worktrees, and drill output. |
| Reverse proxy (recommended) | Terminate TLS, forward `/api`, `/rpc`, `/events`, and the WebUI. List it in `TSUKAIMA_TRUSTED_PROXIES`. |
| NapCat instance | OneBot v11 WebSocket server; see [NapCat setup](#3-napcat-websocket-setup). |
| Chromium (CI only) | `bunx playwright install chromium` for `bun run test:e2e`. |

Build and start:

```sh
bun install --frozen-lockfile
bun run --filter '@tsukaima/web' build
NODE_ENV=production bun run --filter '@tsukaima/server' start
```

The server binds `TSUKAIMA_HOST:TSUKAIMA_PORT` (default `127.0.0.1:7420`) and the built WebUI is served
from the same origin behind the proxy.

## 2. Secrets and environment configuration

Secrets never enter Git, logs, prompts, reports, or exported bundles. Configure them through the
process environment or the plugin settings panel; the API only ever returns `secretsSet` flags.

Required for a production boot:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Enables the production secret requirement and secure defaults. |
| `TSUKAIMA_AUTH_SECRET` (or `BETTER_AUTH_SECRET`) | At least 32 characters; required in production. |
| `TSUKAIMA_PUBLIC_URL` | Exact public HTTPS origin used by Better Auth. |
| `TSUKAIMA_ADMIN_USERNAME`, `TSUKAIMA_ADMIN_PASSWORD` | First-run administrator bootstrap (password ≥ 8 chars). Keep them available until the first successful boot after upgrade. |
| `TSUKAIMA_DATA_DIR` | Absolute path to the persistent data directory. |

Recommended:

| Variable | Purpose |
| --- | --- |
| `TSUKAIMA_HOST`, `TSUKAIMA_PORT` | Bind address and port. |
| `TSUKAIMA_WEB_ORIGIN`, `TSUKAIMA_TRUSTED_ORIGINS` | Browser origins accepted by Better Auth. |
| `TSUKAIMA_TRUSTED_PROXIES` | Reverse proxies whose forwarded client IP headers may be trusted. |
| `TSUKAIMA_AUTH_SECURE_COOKIES` | Defaults to `true` when `TSUKAIMA_PUBLIC_URL` is HTTPS. |
| `TSUKAIMA_LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. |
| `TSUKAIMA_BACKUP_DRILL_INTERVAL_MS` | Optional scheduled backup drill cadence; unset/`0` disables it. |
| `TSUKAIMA_BACKUP_DRILL_ROOT` | Optional drill output root (default `<data>/backup-drills`). |

Plugin-owned secrets use the manifest `configEnv` fallbacks, for example
`TSUKAIMA_ONEBOT_ACCESS_TOKEN` and `TSUKAIMA_OPENAI_API_KEY`. Prefer storing them in the plugin panel so
they live in the domain database rather than the process environment.

Rotation: change the value in the plugin panel or environment, restart the server when a provider
secret changes, and confirm `bun run check:secrets` still passes before committing.

## 3. NapCat WebSocket setup

Tsukaima connects **outbound** to NapCat's OneBot v11 WebSocket server.

1. In NapCat, enable the WebSocket server (forward mode) and choose a port, for example `3001`.
2. Set an access token. Tsukaima sends it as `Authorization: Bearer <token>`.
3. Restrict network reachability so only the Tsukaima host can connect.
4. Configure the `onebot-napcat` plugin (or `TSUKAIMA_ONEBOT_WS_URL` /
   `TSUKAIMA_ONEBOT_ACCESS_TOKEN` fallbacks):

```json
{
	"mode": "forward",
	"wsUrl": "ws://<napcat-host>:3001",
	"accessToken": "<secret>",
	"botAccountId": "<qq-account>"
}
```

Reverse mode (`mode: "reverse"`, `host`/`port`) is also supported when NapCat must dial Tsukaima.

Verification:

- `GET /healthz` reports `ready`; `GET /readyz` returns `204`.
- The Plugins page shows `onebot-napcat` as healthy with an increasing `Events` metric.
- Runtime logs show `OneBot channel started` and no reconnect storm.
- Reconnecting from the plugin panel restarts only the channel, not the process.

## 4. Health and readiness endpoints

| Endpoint | Success | Failure | Meaning |
| --- | --- | --- | --- |
| `GET /healthz` | `200` | `503` for `failed`/`maintenance` | JSON lifecycle snapshot (`state`, `stage`, `startedAtMs`, optional `reason`). |
| `GET /readyz` | `204` | `503` | Ready for traffic: storage, migrations, plugins, scheduler, and channels are up. |

```sh
curl -fsS http://127.0.0.1:7420/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7420/readyz
```

`/healthz` may answer `200` while the process is still `starting`; gate traffic on `/readyz`.
Both `/rpc/*` and `/events/*` require the Better Auth admin session cookie.

## 5. Offline DSH snapshot → dry-run → import → verify → rollback

The Migration Kit is offline for structural steps. Host/project/container values come only from
flags or environment variables; nothing is hard-coded.

```sh
# 1. Read-only snapshot (local copies or a remote target via flags/env)
bun tools/migration/src/cli.ts snapshot \
  --source /path/to/dsh-home --source /path/to/dsh-workspace \
  --output /srv/tsukaima-migration/snapshot

# 2. Inventory and normalization report
bun tools/migration/src/cli.ts inspect --source /srv/tsukaima-migration/snapshot

# 3. Mandatory dry run against the real target database
bun tools/migration/src/cli.ts dry-run \
  --source /srv/tsukaima-migration/snapshot \
  --target sqlite:/srv/tsukaima/data/domain.sqlite \
  --plan /srv/tsukaima-migration/plan.json

# 4. Import using the reviewed dry-run plan (creates the pre-import backup first)
bun tools/migration/src/cli.ts import \
  --source /srv/tsukaima-migration/snapshot \
  --target sqlite:/srv/tsukaima/data/domain.sqlite \
  --plan /srv/tsukaima-migration/plan.json \
  --backup-dir /srv/tsukaima/data/migration-backups

# 5. Verify counts, hashes, references, and the fake-model smoke turn
bun tools/migration/src/cli.ts verify \
  --source /srv/tsukaima-migration/snapshot \
  --target sqlite:/srv/tsukaima/data/domain.sqlite

# 6. Roll back a specific run if verification fails
bun tools/migration/src/cli.ts rollback \
  --target sqlite:/srv/tsukaima/data/domain.sqlite \
  --run-id <run-id> \
  --backup-dir /srv/tsukaima/data/migration-backups
```

Rules:

- Run `dry-run` before every `import`; import refuses a different snapshot once one is recorded.
- Stop the server before rollback. `restorePreImportBackup` is authoritative and removes partial media.
- Reports are secret-free by default. Never enable content samples on a shared machine.
- After import, open a few conversations read-only in the WebUI and confirm persona/memory/sticker
  counts before enabling live NapCat traffic.

## 6. Scheduled backup and restore drills

The drill snapshots `domain.sqlite`, `durable.sqlite`, and the `blobs/` directory after
`PRAGMA wal_checkpoint(FULL)`, verifies the manifest hashes, restores into an isolated staging
directory, runs `PRAGMA integrity_check` on both databases, and compares blob SHA-256 hashes and file
counts. The JSON report contains only logical names, counts, hashes, and integrity results.

Manual run:

```sh
bun run ops:backup-drill -- --data-dir /srv/tsukaima/data
# or
bun tools/ops/backup-drill.ts --data-dir /srv/tsukaima/data --keep-staging
```

Outputs:

- `<data>/backup-drills/backups/<runId>/` — manifest and copied files.
- `<data>/backup-drills/reports/<runId>-drill.json` — secret-free drill report.

Exit code `0` means the drill passed; `1` means it failed and the report names the reason.

Scheduling: set `TSUKAIMA_BACKUP_DRILL_INTERVAL_MS` (milliseconds) to run drills on a fixed interval.
The scheduler is disabled by default and in tests, skips an overlapping interval instead of queuing,
and can also be triggered explicitly through `lifecycle.runBackupDrill()`. A failed drill is logged
at `warn` with the report path; alert on it.

Restore for real (not a drill):

1. Stop the server.
2. Copy `<runId>/manifest.json` and the recorded files back over the data directory, or call
   `restorePreImportBackup` from a script after verifying the manifest.
3. Start the server and check `/readyz`.
4. Keep the previous data directory until the next successful drill.

## 7. Self-iteration supervised reload and recovery

Self-iteration is disabled for ordinary conversations. Grant the `coding` capability through the
conversation policy before any coding tool is offered, and review every proposal/approval.

Deployment flow:

1. The model creates a task and a proposal in a worktree.
2. The WebUI shows the diff, tests/builds, risk, rollback notes, and approval cards.
3. An administrator approves; the deployment runs the pre-health check, reload, then the post-health
   check. A failed post-check automatically rolls back.
4. `autoApply` stays off unless explicitly enabled.

Recovery after a failed or interrupted reload:

1. Check `GET /healthz`; a `failed`/`maintenance` state or a missing `/readyz` means traffic must stop.
2. Read the deployment record (pre-check, reload, post-check, rollback) on the self-iteration panel.
3. If a rollback was recorded, confirm the server is running the previous revision, then verify
   `/readyz` and a read-only conversation before resuming traffic.
4. If no rollback was recorded, redeploy the last known-good revision from its proposal, or restore
   the pre-deployment backup and restart.
5. Write down the incident, the failed revision, and the recovery action in the audit trail.

Never let a model invoke maintenance verbs directly; only the WebUI approval path may deploy or roll
back.

## 8. Release verification checklist

Run before every cutover:

```sh
bun run check:secrets
bun --filter '@tsukaima/web' check:i18n
bun --filter '@tsukaima/web' lint:i18n
bun --filter '@tsukaima/web' build
bun run check
bun run test:e2e
bun run ops:backup-drill -- --data-dir "$TSUKAIMA_DATA_DIR"
```

Then confirm `/healthz` and `/readyz`, open a local WebUI chat, and send one supervised message
through the connected NapCat channel.
