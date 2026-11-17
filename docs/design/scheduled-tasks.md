# Scheduled tasks: design

**Status:** design proposal, 17 November 2026  
**Audience:** implementers, reviewers, and operators  
**Scope:** a first-class, durable, user-visible scheduled-task system for Tsukaima, including
WebUI task management and chat-linked schedules. This document does not implement the feature.

## 1. Summary

Tsukaima already has several time-based mechanisms, but no single user-facing model for durable
scheduled work. The existing pieces are intentionally narrow:

- `PluginTaskService` is a durable plugin task runner with repeat support.
- `proactive-scheduler` owns proactive policy, gates, decisions, and its own task rows.
- `PromptHookService` owns context injection and reserved resume turns.
- `RestartCoordinator` owns a single maintenance restart window.
- Conversation pacing, reply reconciliation, transport reconnects, rate limits, and request
  timeouts are internal timing concerns.

This design adds one host-owned schedule domain for work a user or agent explicitly wants to
happen later. It is deliberately not a general cron daemon and not a replacement for internal
timers. The durable schedule domain owns:

- one-time reminders;
- recurring check-ins and messages;
- delayed agent turns;
- delayed workspace turns;
- a small, explicit notification action that does not invoke a model.

The design keeps `proactive-scheduler` responsible for policy-driven initiative. It does not
move quiet-hours, warmness, probability, or proactive decision logic into the new domain. It
also does not put user schedules into a plugin database.

This design supersedes only the stale “current boundary” statement in
`docs/specs/proactive-scheduler.md`. That document's task model and policy decisions remain
useful, but its claim that no scheduler implementation exists is no longer accurate.

The recommended implementation is:

1. Add `schedules` and `schedule_occurrences` tables to `domain.sqlite` through generated Drizzle
   migrations.
2. Add a host-owned `ScheduleService` and `ScheduleRunner` in `apps/server`.
3. Add a single `admin.schedules` contract namespace in `packages/contracts`.
4. Reuse the existing session messaging, conversation lock, reply expectation, audit, and
   channel paths for execution.
5. Add a `/tasks` rail destination, a `TasksSidebar`, and linked-task affordances in the chat
   sidebar and session inspector.
6. Converge timed `hook_schedule` calls on the schedule service while keeping `next-turn` and
   `after-restart` prompt hooks.

## 2. Goals and non-goals

### Goals

- Durable schedules survive process restart, plugin reload, and ordinary crashes.
- A schedule cannot double-fire because of retries, startup recovery, or a duplicated UI action.
- Users can inspect, create, edit, pause, resume, cancel, and run schedules from the WebUI.
- Chat and workspace sessions can show the schedules linked to them.
- Calendar recurrences use an IANA time zone, not a fixed UTC offset.
- Execution uses the same conversation/session semantics as ordinary turns and background turns.
- Every privileged mutation is audited and every schedule has a clear owner and target.
- The implementation fits the existing package boundaries and contracts.

### Non-goals

- A full cron parser or arbitrary RRULE support in the first phase.
- External calendar synchronization.
- Multi-user tenancy and per-user schedule ownership. Tsukaima currently has a single
  administrator principal.
- Arbitrary shell, Docker, secret, or production-database execution from a schedule.
- Replacing proactive policy evaluation, quiet hours, or decision logging.
- Replacing internal retry backoff, lease heartbeats, pacing, rate limiting, or request timeouts.
- Sending to a different conversation without an explicit, authorized target.

## 3. Existing time-based features

The inventory below distinguishes durable domain work from internal timing. “Durable” means a
row or intent survives restart and must be reconciled. “User-visible” means the WebUI or a model
can reasonably treat it as a task.

| Feature | Current location | Durability | User-visible | Proposed disposition |
| --- | --- | --- | --- | --- |
| Plugin task runner | `apps/server/src/services/plugin-task-service.ts` | `plugin_tasks` rows | No, except plugin panels | Keep for plugin-internal work; do not use as the user schedule store |
| Proactive tick | `plugins/proactive-scheduler/src/service.ts` | Recurring `plugin_tasks` row | Plugin panel only | Keep as proactive policy automation |
| Proactive scheduled tasks | `plugins/proactive-scheduler/src/repository.ts` | Plugin-owned SQLite | Plugin panel only | Keep during phase 1; converge later if needed |
| Prompt context hooks | `apps/server/src/services/prompt-hooks.ts` | `prompt_hooks` rows | `hook_list` tool | Keep |
| Timed resume hooks | `apps/server/src/services/prompt-hooks.ts`, `apps/server/src/services/session-messaging.ts` | `prompt_hooks` rows plus per-hook `setTimeout` | `hook_schedule` tool | Replace timed use with schedules; keep after-restart |
| `hook_schedule` with `timing=at` | `apps/server/src/services/workspace-tools.ts` | `prompt_hooks` row | Model tool | Become a compatibility wrapper over `ScheduleService` |
| Restart/update window | `apps/server/src/services/restart-coordinator.ts` | `runtime_restarts` plus runtime hook | Settings page | Keep internal |
| Backup/restore drill interval | `apps/server/src/services/backup-drill-scheduler.ts` | No durable intent; in-memory interval | Diagnostics/ops | Keep internal |
| Memory expiry | `apps/server/src/services/memory-service.ts` | Recurring `plugin_tasks` row | Memory page | Keep internal |
| Memory extraction/compaction | `apps/server/src/services/memory-service.ts` | `plugin_tasks` rows | Memory page | Keep internal |
| Reply expectation abandonment | `apps/server/src/services/reply-expectations.ts` | `reply_dispatch_expectations` rows | No | Keep internal |
| Reply dispatcher reconciliation | `apps/server/src/services/reply-dispatcher.ts` | Durable intents plus interval | No | Keep internal |
| Activity flush and pacing | `packages/core/src/conversation-host.ts` | In-memory timers | No | Keep internal |
| Busy-run hold and run timeout | `packages/core/src/conversation-host.ts` | In-memory timers | No | Keep internal |
| Event stream heartbeat | `apps/server/src/services/event-stream.ts` | In-memory interval | No | Keep internal |
| Auth sign-in rate limit | `apps/server/src/services/auth.ts` | In-memory window | No | Keep internal |
| OneBot reconnect backoff | `plugins/onebot-napcat/src/protocol/channel.ts` | In-memory timer | Diagnostics | Keep internal |
| Search/fetch request timeout | `plugins/search-fetch/src/fetch.ts` | Request-scoped timer | No | Keep internal |
| Sidechat timeout | `apps/server/src/services/sidechat.ts` | Request-scoped timer | No | Keep internal |
| Media fetch timeout | `apps/server/src/services/media-fetch-guard.ts` | Request-scoped timer | No | Keep internal |
| Follow-up intent outbox | `apps/server/src/services/follow-up-intents.ts` | `plugin_follow_up_intents` rows | No | Keep as durable handoff pattern |

`docs/specs/proactive-scheduler.md` still says “no runtime scheduler/proactive implementation
exists.” That boundary is stale: the plugin and host task engine are implemented. This design
keeps their ownership and replaces only the user-facing timed-schedule gap.

### 3.1 What is suitable for a durable user schedule

A time-based feature belongs in the new schedule domain when all of the following are true:

- a user or agent explicitly asked for it;
- it should still exist after a restart;
- it has a meaningful target session;
- it may need retry, pause, cancel, or an occurrence history;
- a human can reasonably manage it in a task list.

Examples: “remind me at 09:00”, “every weekday at 18:00 check the workspace”, “run this
follow-up tomorrow”, “send this note to the test chat at noon”.

### 3.2 What must remain internal timing

The following are not schedules:

- poll intervals, heartbeats, and reconciliation loops;
- request timeouts and transport reconnect delays;
- retry backoff and lease renewal;
- quiet-hour evaluation, warmness, probability, and proactive gate timing;
- activity-window debounce and reply pacing;
- rate-limit windows and expectation TTLs;
- a single maintenance restart deadline.

Putting these in a user-visible schedule table would create noise, make operational timing
editable, and imply guarantees the runtime does not provide. Keep them close to the service that
owns the behavior.

## 4. Product model and terminology

| Term | Meaning |
| --- | --- |
| Schedule | A durable definition of work to perform at one or more times. |
| Occurrence | One materialized due time for a schedule, with its own status and attempt history. |
| Target | The session that receives the work. A workspace is also a session. |
| Action | What the occurrence does: `agent_turn`, `workspace_turn`, or `notify`. |
| Recurrence | How the next due time is calculated: `once`, `interval`, or `calendar`. |
| Catch-up | What to do when the process was unavailable at the due time. |
| Schedule runner | The single host loop that materializes and claims due occurrences. |

Avoid calling these “tasks” in code. Tsukaima already has `coding_tasks`, `workspace_todos`, and
`plugin_tasks`. The UI may say “Scheduled tasks”, but the domain type should be `Schedule`.

## 5. Architecture

```text
WebUI / chat tool / workspace tool
                |
                v
        admin.schedules (oRPC)
                |
                v
        ScheduleService  <---- audit log
          |          |
          |          +---- ScheduleRunner (one 15s tick)
          |                    |
          |                    v
          |            schedule_occurrences
          |                    |
          |                    v
          +-----------> ScheduleExecutor
                               |
                 +-------------+-------------+
                 |                           |
                 v                           v
       SessionMessagingService        OutboundService
       (agent/workspace turns)        (notify action)
                 |                           |
                 v                           v
       PiDurableConversationHost      ChannelRegistry
```

### 5.1 Package boundaries

| Concern | Location |
| --- | --- |
| Wire schemas and types | `packages/contracts/src/schedules.ts`, exported from `packages/contracts/src/index.ts` |
| Tables and indexes | `packages/db/src/schema.ts`; generated SQL in `packages/db/drizzle/` |
| CRUD, recurrence, materialization, recovery | `apps/server/src/services/schedule-service.ts` |
| Pure time-zone/recurrence helpers | `apps/server/src/services/schedule-time.ts` |
| Execution against sessions and channels | `apps/server/src/services/schedule-executor.ts` |
| RPC handlers | `apps/server/src/rpc/admin.ts` |
| Lifecycle wiring | `apps/server/src/lifecycle.ts` |
| WebUI route and shell | `apps/web/src/routes/(tasks)/`, `apps/web/src/routes/_modules/shell/` |

The schedule domain is host-owned. It must not be implemented inside
`plugins/proactive-scheduler`, because the WebUI shell, session services, and workspace services
need direct access to schedules and because plugin databases are isolated by file.

### 5.2 Why not reuse `plugin_tasks` as the user schedule store

`plugin_tasks` is a useful durable worker table, but it is not the right public model:

- it is scoped to a plugin id and plugin permission set;
- it has no occurrence history or schedule definition;
- its current claim loop marks a task `running` and does not recover orphaned `running` rows on
  startup;
- its `intervalMs` repeat is a worker interval, not a calendar recurrence;
- exposing it directly would create a second API shape beside the contracts.

The schedule domain may reuse the *ideas* of durable rows, atomic claims, dedupe keys, and
backoff. It should not expose `plugin_tasks` to the WebUI.

## 6. Data model

### 6.1 `schedules`

```sql
CREATE TABLE schedules (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	action_kind TEXT NOT NULL CHECK (action_kind IN ('agent_turn', 'workspace_turn', 'notify')),
	target_session_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	target_chat_object_id TEXT REFERENCES chat_objects(id) ON DELETE SET NULL,
	prompt TEXT NOT NULL,
	time_zone TEXT NOT NULL,
	recurrence_kind TEXT NOT NULL CHECK (recurrence_kind IN ('once', 'interval', 'calendar')),
	recurrence_json TEXT NOT NULL,
	catch_up TEXT NOT NULL CHECK (catch_up IN ('skip', 'latest', 'all')),
	grace_ms INTEGER NOT NULL,
	max_attempts INTEGER NOT NULL,
	respect_quiet_hours INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'failed')),
	revision INTEGER NOT NULL DEFAULT 1,
	next_run_at_ms INTEGER,
	last_run_at_ms INTEGER,
	run_count INTEGER NOT NULL DEFAULT 0,
	max_runs INTEGER,
	owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'agent', 'plugin', 'system')),
	owner_id TEXT NOT NULL,
	owner_plugin_id TEXT,
	source TEXT NOT NULL,
	dedupe_key TEXT,
	paused_at_ms INTEGER,
	completed_at_ms INTEGER,
	cancelled_at_ms INTEGER,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE INDEX schedules_due_idx ON schedules(status, next_run_at_ms);
CREATE INDEX schedules_target_idx ON schedules(target_session_id, status, next_run_at_ms);
CREATE UNIQUE INDEX schedules_dedupe_unique
	ON schedules(dedupe_key)
	WHERE dedupe_key IS NOT NULL;
```

Notes:

- `target_chat_object_id` is derived from the session, not trusted from the client.
- `recurrence_json` is a discriminated union keyed by `kind`. See section 7.
- The service writes the effective catch-up, grace, and attempt values into every row. The table
  has no recurrence-dependent defaults; `once`, `interval`, and `calendar` choose different
  defaults.
- `respect_quiet_hours` defaults to `0` for explicit user schedules. Proactive-created schedules
  may set it to `1`.
- `owner_plugin_id` is reserved for the later proactive convergence. It is null for WebUI and
  ordinary agent-created schedules.
- `source` is a short audit/debug label such as `webui`, `chat-tool`, `workspace-tool`,
  `hook-compat`, or `proactive`.
- Timestamps are integer epoch milliseconds, matching `plugin_tasks` and `prompt_hooks`.

### 6.2 `schedule_occurrences`

```sql
CREATE TABLE schedule_occurrences (
	id TEXT PRIMARY KEY,
	schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
	scheduled_for_ms INTEGER NOT NULL,
	occurrence_key TEXT NOT NULL,
	trigger_kind TEXT NOT NULL
		CHECK (trigger_kind IN ('scheduled', 'manual', 'catch_up')),
	schedule_revision INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN (
			'pending', 'claimed', 'running', 'succeeded', 'failed',
			'skipped', 'uncertain', 'cancelled'
		)),
	attempt INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	available_at_ms INTEGER NOT NULL,
	lease_owner TEXT,
	lease_expires_at_ms INTEGER,
	submission_request_id TEXT,
	message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
	snapshot_json TEXT NOT NULL,
	result_json TEXT,
	error TEXT,
	started_at_ms INTEGER,
	finished_at_ms INTEGER,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX schedule_occurrences_key_unique
	ON schedule_occurrences(schedule_id, occurrence_key);
CREATE UNIQUE INDEX schedule_occurrences_scheduled_unique
	ON schedule_occurrences(schedule_id, scheduled_for_ms)
	WHERE trigger_kind = 'scheduled';
CREATE INDEX schedule_occurrences_claim_idx
	ON schedule_occurrences(status, available_at_ms);
CREATE INDEX schedule_occurrences_lease_idx
	ON schedule_occurrences(status, lease_expires_at_ms);
CREATE INDEX schedule_occurrences_schedule_idx
	ON schedule_occurrences(schedule_id, scheduled_for_ms DESC);
```

`occurrence_key` is `scheduled:<scheduledForMs>` for a regular occurrence and
`manual:<uuid>` for a run-now occurrence. The partial unique index prevents duplicate regular
occurrences while still allowing a manual run at the same instant as a regular one.

`snapshot_json` is written when the occurrence is materialized. It contains the target session,
action kind, prompt, quiet-hours flag, and schedule revision. This makes an occurrence immutable:
editing a schedule affects future occurrences, not one already queued or running. It also gives
the executor and audit trail a stable record of what was intended.

### 6.3 Optional occurrence events

The first phase can use `result_json` and the audit log. If operators need a per-transition
history, add a later `schedule_occurrence_events` table with `occurrence_id`, `from_status`,
`to_status`, `at_ms`, and `detail`. Do not add it preemptively.

### 6.4 Relationship to existing tables

- `schedules.target_session_id` references `conversations.id`. A workspace is a conversation
  with `kind = "workspace"` and a `workspace_sessions` row.
- `schedule_occurrences.message_id` references the domain message row used for a notification or
  a scheduled turn, when one exists.
- No SQL joins cross into plugin databases.
- `schedules` is not a replacement for `runtime_restarts`, `prompt_hooks`, or `plugin_tasks`.

## 7. Recurrence and time zones

### 7.1 Recurrence schema

Use a discriminated union in `packages/contracts/src/schedules.ts`:

```ts
export const scheduleRecurrenceSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("once"),
		at: z.string().datetime(),
	}).strict(),
	z.object({
		kind: z.literal("interval"),
		everyMs: z.number().int().min(60_000),
		anchorAt: z.string().datetime(),
		until: z.string().datetime().optional(),
	}).strict(),
	z.object({
		kind: z.literal("calendar"),
		time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
		daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
		startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
		until: z.string().datetime().optional(),
	}).strict(),
]);
```

The first phase supports:

- `once`: an absolute instant;
- `interval`: a fixed duration from an anchor, with an optional end;
- `calendar`: a local wall-clock time, an optional set of weekdays, and a start date.

A later phase may add `monthly` or a constrained cron expression behind a new union member. Do
not accept arbitrary cron strings in phase 1; they are hard to validate, preview, and explain.

### 7.2 Time-zone rules

Store an IANA time-zone identifier such as `Asia/Taipei` or `America/New_York`. Do not store a
fixed `timezoneOffsetMinutes` for user schedules. The existing proactive policy uses a fixed
offset for quiet hours and daily counters; that is acceptable for a coarse policy gate but is not
correct for a calendar commitment across daylight-saving transitions.

Rules:

- The server computes occurrences in the schedule’s time zone, independent of the host process
  time zone.
- The WebUI displays occurrences in the browser’s local zone by default and shows the schedule’s
  zone when it differs.
- Validate the zone with `Intl.DateTimeFormat(undefined, { timeZone })` before storing it.
- For a nonexistent local time at a spring-forward transition, run at the first valid local
  instant after the gap.
- For an ambiguous local time at a fall-back transition, use the earlier occurrence of that
  local time by default. Document this in the creation UI.
- A calendar schedule’s `startDate` is interpreted in its own zone, not UTC.

Implement the conversion in a pure helper, `apps/server/src/services/schedule-time.ts`:

```ts
export function nextOccurrence(input: {
	readonly recurrence: ScheduleRecurrence;
	readonly timeZone: string;
	readonly afterMs: number;
}): number | undefined;
```

The helper must be deterministic and have no database access. It can use `Intl.DateTimeFormat`
with `formatToParts` and a round-trip validation step; if the repository later adopts Temporal,
the implementation can change without changing the contract.

### 7.3 Catch-up policy

| Recurrence | Default | Behavior when the process was down |
| --- | --- | --- |
| `once` | `latest`, grace 24h | Run once if within grace; otherwise mark `skipped` with `missed` |
| `interval` | `latest`, grace min(interval, 1h) | Run the latest missed occurrence once, then resume the interval |
| `calendar` | `skip`, grace 15m | Skip a stale local-time occurrence and advance to the next |

`all` is available for advanced/admin use and is capped at 10 occurrences per recovery pass.
Never replay an unbounded backlog. The UI must show the selected catch-up policy in plain
language.

### 7.4 Next-run calculation

`ScheduleService` computes `next_run_at_ms` from the recurrence, the schedule's `timeZone`, and
the last scheduled occurrence, not from `Date.now()` alone. This avoids drift:

- `interval`: `next = anchorAt + n * everyMs`, choosing the smallest value strictly after the
  last materialized occurrence;
- `calendar`: the next matching local date/time after the last occurrence, in the schedule zone;
- `once`: `at`, then `null`.

The service must advance `next_run_at_ms` in the same transaction that inserts the occurrence.
If it cannot, the unique occurrence index makes the next tick safe to retry.

## 8. Contracts and RPC

Add a single new contract file, `packages/contracts/src/schedules.ts`, and export it from
`packages/contracts/src/index.ts`. Do not create a parallel hand-written type in the server or
WebUI.

### 8.1 Shared schemas

```ts
export const scheduleActionKindSchema = z.enum(["agent_turn", "workspace_turn", "notify"]);
export const scheduleStatusSchema = z.enum([
	"active", "paused", "completed", "cancelled", "failed",
]);
export const scheduleOccurrenceStatusSchema = z.enum([
	"pending", "claimed", "running", "succeeded", "failed",
	"skipped", "uncertain", "cancelled",
]);

export const scheduleSummarySchema = z.object({
	actionKind: scheduleActionKindSchema,
	catchUp: z.enum(["skip", "latest", "all"]),
	createdAt: z.string(),
	id: z.string(),
	lastRunAt: z.string().nullable(),
	nextRunAt: z.string().nullable(),
	ownerKind: z.enum(["user", "agent", "plugin", "system"]),
	recurrence: scheduleRecurrenceSchema,
	runCount: z.number().int().nonnegative(),
	source: z.string(),
	status: scheduleStatusSchema,
	targetChatObjectId: z.string().nullable(),
	targetSessionId: z.string(),
	targetSessionTitle: z.string(),
	timeZone: z.string(),
	title: z.string(),
	updatedAt: z.string(),
});
```

Inputs must be `.strict()` and compatible with `exactOptionalPropertyTypes`:

```ts
export const scheduleCreateInputSchema = z.object({
	actionKind: scheduleActionKindSchema.default("agent_turn"),
	catchUp: z.enum(["skip", "latest", "all"]).optional(),
	dedupeKey: z.string().min(1).max(200).optional(),
	graceMs: z.number().int().min(0).max(7 * 24 * 3_600_000).optional(),
	maxRuns: z.number().int().min(1).max(10_000).optional(),
	maxAttempts: z.number().int().min(1).max(10).optional(),
	prompt: z.string().trim().min(1).max(10_000),
	recurrence: scheduleRecurrenceSchema,
	respectQuietHours: z.boolean().optional(),
	targetSessionId: z.string().min(1),
	timeZone: z.string().min(1),
	title: z.string().trim().min(1).max(200),
}).strict();
```

The schedule-level `timeZone` is the single source of truth for display, audit, and calendar
calculation. A calendar recurrence stores only local wall-clock fields; it does not carry a
second zone that could drift from the schedule.

### 8.2 Contract namespace

Add to `appContract` in `packages/contracts/src/api.ts`:

```ts
admin: {
	schedules: {
		create: oc.input(scheduleCreateInputSchema).output(scheduleDetailSchema)
			.meta({ audit: true }),
		get: oc.input(scheduleGetInputSchema).output(scheduleDetailSchema.nullable()),
		list: oc.input(scheduleListInputSchema).output(scheduleListOutputSchema),
		update: oc.input(scheduleUpdateInputSchema).output(scheduleDetailSchema)
			.meta({ audit: true }),
		pause: oc.input(scheduleIdInputSchema).output(scheduleSummarySchema)
			.meta({ audit: true }),
		resume: oc.input(scheduleIdInputSchema).output(scheduleSummarySchema)
			.meta({ audit: true }),
		cancel: oc.input(scheduleCancelInputSchema).output(scheduleSummarySchema)
			.meta({ audit: true }),
		runNow: oc.input(scheduleIdInputSchema).output(scheduleOccurrenceSchema)
			.meta({ audit: true }),
		occurrences: oc.input(scheduleOccurrencesInputSchema)
			.output(scheduleOccurrencesOutputSchema),
		preview: oc.input(schedulePreviewInputSchema).output(schedulePreviewOutputSchema),
		summary: oc.input(scheduleSummaryInputSchema).output(scheduleSummaryOutputSchema),
	},
	// existing namespaces...
}
```

`summary` is used by the rail badge and chat-tree badges. It returns global counts plus counts
for a bounded list of session ids, avoiding an N+1 query from the chat tree.

`scheduleCancelInputSchema` is `{ scheduleId, confirm: true }`. Cancellation is destructive but
retains history; the explicit confirmation keeps it distinguishable from a reversible pause and
matches the repository convention for consequential admin actions.

### 8.3 Errors and validation

Use the existing error vocabulary in `docs/architecture/api.md`:

- `NOT_FOUND` for an unknown schedule or session;
- `INVALID_INPUT` for bad recurrence, bad zone, or a target that is not a session;
- `CONFLICT` for an archived target, a schedule that is already cancelled, or a duplicate
  occurrence;
- `FORBIDDEN` for a model-tool scope violation or a target the caller may not address;
- `CHANNEL_UNAVAILABLE` and `MODEL_UNAVAILABLE` when execution cannot proceed;
- `TASK_FAILED` for a terminal execution failure.

Do not return raw SQLite errors or prompt text in an error message. Store the safe error on the
occurrence and return a stable code/message.

## 9. Execution

### 9.1 Runner lifecycle

Add `ScheduleRunner` to the lifecycle:

- construct it after `domainDatabase`, `sessionMessaging`, `outbound`, and the conversation host
  exist;
- call `await scheduleService.recover()` after the lifecycle is ready and before the first
  tick;
- start one `setInterval` at 15 seconds, `unref()` it, and guard against overlapping ticks;
- expose `tick()` for deterministic tests;
- stop the runner before closing the database.

This is one host loop for all user schedules, not one timer per schedule. Do not use
`setTimeout` per schedule; long delays are represented by `next_run_at_ms` and recovered from
the database.

### 9.2 Materialize

For each active schedule whose `next_run_at_ms <= now`:

1. In a transaction, insert an occurrence with `occurrence_key = "scheduled:<scheduledForMs>"`.
2. Write the immutable `snapshot_json`.
3. Compute and store the next `next_run_at_ms`.
4. If the recurrence has ended or `max_runs` is reached, set the schedule to `completed`.

If the insert hits the unique index, the occurrence already exists; continue without creating a
second one. This makes a crash between insert and schedule update safe.

### 9.3 Claim

Claim an occurrence atomically:

```sql
UPDATE schedule_occurrences
SET status = 'claimed',
	attempt = attempt + 1,
	lease_owner = ?,
	lease_expires_at_ms = ?,
	updated_at_ms = ?
WHERE id = ?
	AND status = 'pending'
	AND available_at_ms <= ?
RETURNING *;
```

If no row is returned, another worker or an earlier tick claimed it. Do not execute.

After claim, set `status = 'running'` and `started_at_ms`. Renew the lease every 30 seconds for
long model turns. The default lease is 5 minutes; a model turn that exceeds it must not be
reclaimed while the same process is still running it. The lease is primarily a crash-recovery
mechanism, not a concurrency mechanism.

### 9.4 Execute actions

Use the shared `ConversationExecutionLock` around the action, matching background turns in
`apps/server/src/services/plugin-conversation-service.ts`.

| Action | Behavior |
| --- | --- |
| `agent_turn` | Submit a system-authored scheduled prompt into the target chat session and run the model. |
| `workspace_turn` | The same, but require the target session to be a workspace; the schedule uses the normal workspace turn path and workspace tool policy applies. |
| `notify` | Write a notification to the target session; for an external chat, deliver it through the channel only when the channel is available. |

For `agent_turn` and `workspace_turn`:

- Use `SessionMessagingService.sendAgentMessage` with `direction: "system"`,
  `source: "scheduler"`, `deliveryMode: "follow-up"`, and a deterministic `requestId`.
- Add `requestId` and an optional explicit `messageId` to `SendAgentMessageInput`. Pass both to
  `host.append` so a retry reuses the durable submission instead of creating a second turn.
- Persist the domain message with the deterministic message id and `onConflictDoNothing`, then
  reuse the existing row on retry.
- `host.append` already deduplicates a submission by `requestId`; a retry after the answer landed
  therefore does not run the model again. The normal `onTurnAdmitted` reply expectation and
  `ReplyDispatcher` path owns delivery and recovery, exactly as for an ordinary chat turn.
- Do not use `submitBackgroundTurn` for this path. It is the plugin/proactive API and does not
  persist the same domain message row; the scheduled turn should be an ordinary session turn
  with a scheduler-authored envelope.
- Do not grant coding tools to an ordinary chat session because a schedule targeted it. Tool
  policy is still applied by the session service.

For `notify`:

- Insert the message with a deterministic id derived from the occurrence id.
- If the target is a WebUI/workspace session, persist a system message and mark it `sent`.
- If the target is an external chat, use `OutboundService` or a new idempotent outbound helper.
  `OutboundService.send` currently generates a random UUID; add an optional `messageId` or
  `idempotencyKey` so a retry can find the existing row.
- If delivery is `uncertain` (for example a channel timeout), mark the occurrence `uncertain` and
  do not automatically retry. Surface the uncertainty in the UI.

### 9.5 Settle

On success:

- set the occurrence `succeeded`, `finished_at_ms`, and `result_json`;
- increment `schedules.run_count` and set `last_run_at_ms`;
- set the schedule to `completed` if it is one-time or reached `max_runs`.

On failure:

- if `attempt < max_attempts`, set `pending`, `available_at_ms = now + backoff`, and store a safe
  error;
- otherwise set `failed` and store the safe error;
- keep the schedule active so the user can retry or fix the target, unless the recurrence is
  exhausted.

Backoff is exponential with jitter, bounded to the existing task-engine range (about 1 second to
60 seconds) or a schedule-specific range. Do not spin on a permanently broken target.

### 9.6 Pause, cancel, and edit

- **Pause** prevents future materialization; a running occurrence may finish.
- **Resume** recomputes `next_run_at_ms` from the current time, not from the paused time.
- **Cancel** stops future materialization and marks pending occurrences `cancelled`; running
  occurrences are allowed to finish and are recorded.
- **Edit** increments `revision`, affects future occurrences only, and never rewrites history.
- **Run now** inserts an occurrence with `triggerKind = "manual"` and a `manual:<uuid>` key, then
  calls `runner.kick()`; it does not change the regular next-run calculation.
- **Delete** is not exposed in phase 1. Use cancel, which retains the definition and occurrence
  history for audit and troubleshooting. A later retention job can purge terminal occurrences
  older than 90 days; a schedule row is never hard-deleted while audit references it.

## 10. Recovery and idempotency

### 10.1 Recovery on startup

`ScheduleService.recover()` runs before the runner starts:

1. Find `claimed`/`running` occurrences whose lease expired. Return them to `pending` if the
   attempt budget remains; otherwise mark `failed`.
2. Find active schedules with `next_run_at_ms = null` or in the past and recompute/materialize
   according to catch-up policy.
3. Reconcile `succeeded` occurrences whose schedule `next_run_at_ms` was not advanced; recompute
   it from the last occurrence.
4. For `notify` occurrences, check the deterministic message row. If it is already `sent`, mark
   the occurrence `succeeded`; if `uncertain`, leave it uncertain.

Repeated boots must be idempotent. The unique occurrence indexes and deterministic request/message
ids are the backstops.

### 10.2 Crash matrix

| Crash point | Recovery behavior |
| --- | --- |
| After schedule insert, before first occurrence | Next tick materializes it |
| After occurrence insert, before claim | Occurrence remains `pending` and is claimed |
| After claim, before turn submission | Lease expires; occurrence returns to `pending` |
| After turn submission, before occurrence update | Retry uses the same request id; existing answer is resolved |
| After answer, before channel delivery | Existing reply expectation/reconciliation path handles it |
| After channel send, before message status update | `notify` checks the deterministic message row; do not blindly resend |
| After occurrence success, before schedule next-run update | Unique occurrence key plus next-run reconciliation prevents a duplicate |
| During schedule edit | Revision and occurrence snapshot keep old work stable |

### 10.3 Idempotency keys

| Operation | Key |
| --- | --- |
| Schedule creation from a tool/retry | `dedupe_key` partial unique index |
| Occurrence materialization | unique `(schedule_id, occurrence_key)`; partial unique scheduled time |
| Agent/workspace turn | `schedule:<scheduleId>:<scheduledForMs>` request id |
| Notification message | deterministic message id derived from occurrence id |
| Audit | one audit row per successful mutation/transition, with schedule id |

### 10.4 Existing scheduler gap

`PluginTaskService` claims a task by changing `pending` to `running`, but `start()` does not
reset orphaned `running` rows. `proactive-scheduler` works around this only for its own domain
rows. A crash can therefore leave a plugin task, including a recurring tick, permanently
`running`. This is not a blocker for the new schedule domain because schedules use their own
occurrence leases, but it should be fixed separately before relying on `plugin_tasks` for any new
user-facing work.

## 11. Permissions and safety

### 11.1 WebUI

- All `admin.schedules.*` procedures are under `adminBase` and require a Better Auth session.
- Every mutation is marked `.meta({ audit: true })` and writes a domain audit entry with
  `action: "schedule.create"`, `"schedule.update"`, `"schedule.pause"`, `"schedule.resume"`,
  `"schedule.cancel"`, or `"schedule.run-now"`.
- Audit payloads include schedule id, target session id, action kind, recurrence kind, and
  result. Never include the full prompt or chat content.
- The single administrator may manage all schedules. `owner_kind` and `owner_id` record who
  created one; a future multi-user version must add a principal-to-schedule authorization check
  and must not assume the current single-admin model forever.

### 11.2 Model tools

Add host tools, not plugin tools. A model may never widen its own scope: the tools always resolve
the current session from the invocation and do not accept a target-session argument. Admin
management happens through `admin.schedules.*`, not through a model tool.

| Tool | Scope |
| --- | --- |
| `schedule_create` | Current session only |
| `schedule_list` | Current session only |
| `schedule_update` | Current session only |
| `schedule_cancel` | Current session only |
| `schedule_get` | Current session only |

Rules:

- A chat session may schedule only a chat/agent turn or a notification for itself.
- A workspace session may schedule a workspace turn for itself.
- A workspace turn is created only from a workspace session, which already carries the
  workspace/coding capability. An ordinary chat or IM session cannot create one.
- A chat session may spawn or address a workspace through the existing workspace tools, but a
  schedule created in the chat remains targeted at the chat. The workspace can create its own
  schedule while it is the active session.
- A schedule cannot create a second schedule, run arbitrary shell, access Docker, read secrets,
  or bypass the session tool policy.
- A tool may edit or cancel only a schedule it created for its own session. An administrator can
  edit any schedule through the WebUI. This prevents a chat model from changing an operator's
  schedule merely because it targets the same session.
- Enforce caps: at most 25 active schedules per session, at least 60 seconds between interval
  occurrences, prompt length at most 10,000 characters, and a maximum horizon of one year unless
  an admin explicitly extends it.
- A tool-created schedule records `owner_kind = "agent"`, the session id, and a dedupe key
  derived from the tool invocation when one is available.

### 11.3 Execution safety

- Validate the target session and chat object at execution time, not only at creation time.
- If the session or chat is archived, skip the occurrence and pause the schedule with a visible
  reason. Do not silently send to a different session.
- Respect conversation access policy and channel availability for external targets.
- User-created schedules are explicit commitments and bypass proactive quiet hours by default;
  proactive-created schedules set `respect_quiet_hours = 1`.
- Do not log prompts, message text, or full errors containing user content. Log ids, lengths,
  status, and stable reason codes.
- A schedule cannot target `task` or `plugin` sessions; those surfaces have no user-facing
  execution semantics.

## 12. WebUI

### 12.1 Shell and navbar

Add a `tasks` section to the shell:

- `apps/web/src/routes/_modules/shell/app-rail.tsx`:
  - add `"/tasks"` to `RailDestination`;
  - add a `RailLink` with a calendar/clock icon and label from messages;
  - show a badge for overdue plus due-soon active schedules.
- `apps/web/src/routes/_modules/shell/admin-shell.tsx`:
  - add `"tasks"` to `ShellSection`;
  - `sectionFor("/tasks...")` returns `"tasks"`;
  - render `TasksSidebar` for that section;
  - include `/tasks` in `isFullBleedRoute` and `isMobileContentPath`.
- Add a `(tasks)` route group:
  - `/tasks` for the list/empty state;
  - `/tasks/$scheduleId` for detail;
  - optional `?sessionId=` filter used by “View linked tasks”.

Use the existing shell primitives and beUI components. Do not create a second navigation system.

### 12.2 `TasksSidebar`

The sidebar mirrors the existing `RequestsSidebar`/`WorkspaceSidebar` patterns:

- search by title, target session, or status;
- filters: `Upcoming`, `Overdue`, `Paused`, `Completed`, `All`;
- a “New schedule” action;
- rows show title, target session/chat, next run in the browser zone, recurrence summary, and a
  status dot with a text label;
- selecting a row navigates to `/tasks/$scheduleId`; the sidebar remains independently
  scrollable.

On narrow screens, the existing single-column shell behavior applies: the sidebar is the first
pane, and opening a task shows the content pane with a Back action.

### 12.3 Task list and detail

List:

- group by `Overdue`, `Today`, `Next 7 days`, `Later`, and `Paused`;
- show the next three runs from `preview` or the detail payload;
- show the last result/error in a bounded, sanitized form;
- actions: pause/resume, run now, edit, cancel, open target session.

Detail:

- definition: title, action, prompt/text, target session/chat, time zone, recurrence, catch-up,
  max runs, quiet-hours flag;
- next five occurrences with zone-aware labels;
- occurrence history with status, attempt, started/finished time, duration, and safe error;
- links: “Open chat” or “Open workspace”;
- a confirmation dialog for cancel and for “run now” when the target is an external chat.

Creation:

- target picker uses `admin.sessions.search` and displays chat kind, title, and archived state;
- action picker disables `workspace_turn` unless the target is a workspace;
- recurrence builder has `Once`, `Every`, and `Calendar` modes;
- time zone defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone` and is editable;
- a live preview shows the next five occurrences before saving;
- validation errors are inline and do not discard the draft.

### 12.4 Chat sidebar linked tasks

In `apps/web/src/routes/_modules/shell/chat-tree.tsx`, add a compact schedule indicator to each
session row:

- query `admin.schedules.summary` with the visible session ids;
- show a small clock badge with the active count next to the receiving/archived badges;
- clicking the badge opens a popover with the next three linked schedules and actions
  “Open task”, “Pause”, and “View all”;
- “View all” navigates to `/tasks?sessionId=<id>`.

Do not expand every session with a full task list by default. The tree is already dense; the
badge/popover keeps the primary chat navigation readable.

Add a `schedules` tab to `SessionInspectorSidebar`:

- list active and paused schedules for the current session;
- create a schedule with the target prefilled;
- pause/resume/cancel inline;
- show the next run and last result.

Update `InspectorTab`, `isInspectorTab`, and `storedInspectorTab` in
`apps/web/src/routes/(messaging)/_modules/session-inspector-sidebar.tsx`. Keep the existing
surface rules for chat versus workspace.

### 12.5 Realtime updates

Add an SSE event, for example:

```ts
{
	type: "schedule.changed",
	scheduleId: string,
	sessionId: string,
	status: string,
	nextRunAt: string | null,
	occurrenceStatus?: string,
}
```

Emit it after create/update/pause/resume/cancel/run-now and after an occurrence settles. The
WebUI invalidates `admin.schedules.key()` and `admin.schedules.summary.key()` for the affected
session. Do not stream prompt text or error bodies.

### 12.6 Localization

Add every new string to both:

- `apps/web/messages/en.json`
- `apps/web/messages/zh-cn.json`

At minimum: rail label, sidebar filters, empty states, create/edit labels, recurrence labels,
time-zone help, catch-up help, occurrence statuses, confirmation text, and error messages.

## 13. Relationship to proactive messaging and prompt hooks

### 13.1 Proactive scheduler

Keep `proactive-scheduler` as the owner of:

- policy enablement and per-conversation/persona overrides;
- quiet hours, caps, cooldown, warmness, probability, and gates;
- proactive candidate selection and decision logs;
- the proactive tick.

Do not move those rules into the schedule domain. Proactive initiative is stochastic and
policy-gated; a user schedule is an explicit commitment. They should remain distinguishable in
the UI and in audit records.

During phase 1, the task manager shows core schedules only. The existing proactive plugin panel
continues to show proactive tasks and decisions. Do not merge the two lists into one editable
table until ownership and permission semantics are settled.

Long-term convergence:

- Add a host `schedules` SDK bridge for plugins, or a narrow `context.schedules` API.
- Let the proactive plugin create core schedules for explicit `remind`/`nudge`/`workflow`
  actions with `owner_plugin_id = "proactive-scheduler"` and `respect_quiet_hours = 1`.
- Keep proactive `tick`/decision state in the plugin database.
- Migrate existing `plugin_proactive_scheduler_tasks` rows through an idempotent plugin-owned
  importer that reads its own database and calls the host schedule API. Do not join across
  databases.

This convergence is not required to ship the first user-facing schedule system, but the schema
and `owner_plugin_id` field are designed to allow it.

### 13.2 Prompt hooks

Keep:

- `context` hooks for one-turn injection;
- `runtime` hooks for restart/update countdowns;
- `resume` hooks with `afterRestart = true` for boot-reserved work.

Replace the timed `resume` hook use in `hook_schedule`:

- `timing=next-turn` remains a context hook;
- `timing=after-restart` remains a resume hook with `afterRestart = true`;
- `timing=at` creates a `ScheduleService` schedule with `actionKind: "agent_turn"` and
  `source: "hook-compat"`, preserving the tool’s input/output shape where practical.

Existing timed resume hooks remain readable and dispatchable for compatibility. New work should
not create new timed resume hooks. This removes the per-hook `setTimeout` path for user-visible
timed work while keeping prompt-hook semantics for context and restart recovery.

## 14. Migration

### 14.1 Database

1. Update `packages/db/src/schema.ts` with `schedules` and `schedule_occurrences`.
2. Run `cd packages/db && bun run generate` to create a new migration. Do not hand-write or edit
   an applied migration or snapshot.
3. Add a migration test in `packages/db/src/migration.test.ts` that applies the new migration to
   a fresh temporary SQLite database and verifies the tables, indexes, and foreign keys.
4. Verify an existing database with current data applies the migration without touching existing
   rows.

No backfill is needed for the new tables. Existing proactive tasks remain in the plugin database
until the optional convergence phase.

### 14.2 Runtime

- Construct `ScheduleService` and `ScheduleRunner` in `apps/server/src/lifecycle.ts`.
- Expose `lifecycle.schedules` for RPC and session services.
- Call `recover()` after the lifecycle is ready and before starting the runner.
- Stop the runner before closing the domain database.
- Add the schedule runner to readiness diagnostics: if the database is ready but the runner
  cannot start, report a degraded reason rather than silently accepting schedules.

### 14.3 Compatibility

- New `admin.schedules.*` procedures are additive.
- `hook_schedule` keeps its name and existing arguments; only the `timing=at` implementation
  changes.
- Existing `prompt_hooks` and `plugin_tasks` rows are not rewritten.
- Existing proactive panel behavior is unchanged in phase 1.
- No deployment or production command is required for the design itself.

## 15. Observability

Log and count, without content:

- `schedule.created`, `schedule.updated`, `schedule.paused`, `schedule.resumed`,
  `schedule.cancelled`;
- `schedule.occurrence.materialized`, `claimed`, `succeeded`, `failed`, `skipped`, `uncertain`;
- tick duration, due count, claimed count, recovery count, expired-lease count;
- target session id, schedule id, action kind, recurrence kind, attempt, and stable reason code.

Do not log prompts, message text, or full target titles. `previewText` may be used only for
bounded debugging if it cannot contain private content; prefer lengths and ids.

Add a readiness/diagnostics section:

```ts
schedules: {
	runner: "running" | "stopped" | "error";
	active: number;
	overdue: number;
	lastTickAt?: string;
	lastError?: string;
}
```

## 16. Testing

### 16.1 Unit tests

- `schedule-time.test.ts`:
  - once, interval, and weekday recurrences;
  - leap day and month/year boundaries;
  - `Asia/Taipei` (no DST) and `America/New_York`/`Europe/Berlin` DST transitions;
  - nonexistent spring-forward local time;
  - ambiguous fall-back local time;
  - invalid IANA zone rejection;
  - deterministic `afterMs` behavior.
- `schedule-service.test.ts`:
  - materialize once and repeatedly without duplicates;
  - unique occurrence constraint;
  - next-run calculation from the last occurrence, not `Date.now()`;
  - pause/resume/cancel/edit revision semantics;
  - max-runs and one-time completion;
  - catch-up `skip`/`latest`/`all` caps.

### 16.2 Integration tests

Use temporary SQLite databases, a deterministic fake model, and the existing lifecycle test
harness. Never require a real channel, NapCat, model provider, Docker, or network.

- create a schedule, advance the clock, tick, and assert exactly one turn/message;
- tick again and assert no duplicate;
- crash between claim and submission, restart, and assert one execution;
- crash after answer before occurrence update, restart, and assert the existing answer is reused;
- archived target pauses the schedule and records a reason;
- channel unavailable produces `skipped`/`CHANNEL_UNAVAILABLE` without a duplicate send;
- `notify` with an `uncertain` delivery does not auto-retry;
- pause prevents future occurrences while a running occurrence settles;
- run-now creates one manual occurrence and does not disturb the regular next run;
- startup recovery handles expired leases and missed calendar occurrences.

### 16.3 Contract and UI tests

- contract schemas reject unknown fields, bad zones, bad recurrence combinations, and
  cross-field mismatches;
- `admin.schedules` handlers return contract-valid shapes;
- WebUI tests render the task list, create form, empty/error states, and chat-tree badge;
- both `en` and `zh-cn` message files contain every new key;
- keyboard navigation and accessible labels for the rail, sidebar rows, and task actions.

### 16.4 Permission and audit tests

- a model invocation cannot target any session other than the one it is running in;
- an IM session cannot create a workspace turn;
- a schedule cannot target a `task` or `plugin` session;
- cancel/pause/resume/update write audit rows with the schedule id and result;
- audit payloads do not contain prompts or message text.

### 16.5 Migration tests

- fresh database applies the schedule migration;
- existing database with sessions, messages, prompt hooks, and plugin tasks migrates without
  data loss;
- migration is idempotent through the normal Drizzle migration ledger;
- no applied migration or snapshot is edited.

## 17. Phased implementation

### Phase 0: decisions and foundations

- Accept this design and record any deviations in an ADR if they change architecture.
- Add `schedule-time.ts` with unit tests for IANA/DST behavior.
- Add contract schemas and compile-time tests; do not wire UI yet.

Exit: recurrence semantics are reviewable and testable without persistence.

### Phase 1: persistence and runner

- Add `schedules` and `schedule_occurrences` to `packages/db/src/schema.ts`.
- Generate the migration and add migration tests.
- Implement `ScheduleService`, `ScheduleExecutor`, and `ScheduleRunner`.
- Wire `recover()` and `start()`/`stop()` into `apps/server/src/lifecycle.ts`.
- Add feature-flag/config gating so the runner can be disabled in early deployments.

Exit: integration tests prove create, tick, execution, idempotency, and restart recovery with a
fake model.

### Phase 2: contracts and admin API

- Add `admin.schedules.*` to `packages/contracts` and `apps/server/src/rpc/admin.ts`.
- Add audit metadata and explicit domain audit writes.
- Add summary/counts and preview endpoints.
- Add permission tests and error mapping.

Exit: the WebUI can be built entirely against the published contract.

### Phase 3: WebUI task management

- Add `/tasks` route group, `TasksSidebar`, rail destination, and badge.
- Implement list, detail, create, edit, pause/resume, cancel, run-now, and occurrence history.
- Add en/zh-cn messages and responsive/empty/error states.

Exit: an administrator can manage a full schedule lifecycle from the WebUI.

### Phase 4: chat-linked schedules

- Add `admin.schedules.summary` query usage to `ChatTree`.
- Add the session-row clock badge/popover.
- Add the `schedules` inspector tab for chat and workspace.
- Add SSE invalidation.

Exit: linked schedules are visible where the conversation is, without leaving the chat shell.

### Phase 5: model tools and hook convergence

- Add host `schedule_create/list/get/update/cancel` tools with scope checks.
- Convert `hook_schedule timing=at` to the schedule service.
- Keep `next-turn`/`after-restart` prompt hooks.
- Add workspace-turn support and coding-policy denial tests.

Exit: agents can create and manage schedules without bypassing permissions, and timed hook work
has one durable execution path.

### Phase 6: proactive convergence (optional)

- Add a plugin-facing schedules bridge.
- Let proactive explicit reminders use core schedules while policy/decisions remain in the
  plugin.
- Add an idempotent importer for existing proactive tasks.
- Remove the old plugin task table only after a verified migration and rollback plan.

Exit: one user-visible schedule model, with proactive policy still distinct.

### Phase 7: hardening

- Add retention/purge for terminal occurrences.
- Add operational metrics and a runbook entry.
- Run `bun run check`, targeted tests, and the WebUI build.
- Verify no secrets or real chat content appear in logs, tests, or docs.

## 18. Acceptance criteria

The feature is complete when:

- a schedule created in the WebUI survives a server restart and fires exactly once;
- repeated ticks, duplicated requests, and crash recovery do not double-submit a turn or
  duplicate a notification;
- a calendar schedule fires at the intended local time across a DST transition;
- a missed occurrence follows the selected catch-up policy and is visible in history;
- pause/resume/cancel/edit affect future work only and are audited;
- the rail and task page show the same schedules as the chat sidebar/inspector;
- an archived target pauses rather than silently redirects;
- an ordinary chat cannot create a workspace schedule, and a schedule cannot bypass tool policy;
- an admin can address any live session from the task UI, while a model tool can address only the
  session it is running in;
- `bun run typecheck`, `bun run lint`, `bun run format:check`, and targeted tests pass;
- `bun run check:secrets` passes for any changed configuration/docs.

## 19. Open decisions

These should be resolved before or during Phase 1:

1. **Calendar scope:** ship only daily/weekly in Phase 1, or include monthly with an explicit
   month-end policy? Recommendation: daily/weekly first.
2. **Notification action:** include `notify` in Phase 1, or restrict Phase 1 to agent turns?
   Recommendation: include it, because reminders are the most common schedule and should not
   require a model call.
3. **Quiet hours:** should user-created external-chat schedules bypass quiet hours by default?
   Recommendation: yes for explicit schedules; expose an advanced toggle.
4. **Proactive convergence:** migrate proactive task rows in this effort, or keep them separate
   until the core schedule path is proven? Recommendation: separate first, converge later.
5. **Retention:** keep occurrence history indefinitely for audit, or purge terminal rows after a
   fixed period? Recommendation: 90 days, with audit rows retained.

## 20. References

- `apps/server/src/services/plugin-task-service.ts` — durable plugin task claims, repeat, retry.
- `plugins/proactive-scheduler/src/service.ts` — proactive tick, policy gates, scheduled task
  execution.
- `plugins/proactive-scheduler/src/domain.ts` — existing scheduled-task shape and fixed-offset
  quiet hours.
- `apps/server/src/services/prompt-hooks.ts` — context, runtime, and resume hooks.
- `apps/server/src/services/workspace-tools.ts` — `hook_schedule` and session lookup.
- `apps/server/src/services/session-messaging.ts` — shared local-session ingress.
- `apps/server/src/services/plugin-conversation-service.ts` — background turns, markers,
  reply expectations.
- `apps/server/src/services/reply-expectations.ts` — durable pre-submission expectations.
- `apps/server/src/services/follow-up-intents.ts` — durable handoff outbox.
- `apps/server/src/services/restart-coordinator.ts` — restart recovery pattern.
- `packages/core/src/conversation-host.ts` — durable submissions, request ids, execution lock.
- `packages/contracts/src/api.ts` — oRPC contract and existing admin namespaces.
- `packages/db/src/schema.ts` — domain schema and generated migration source.
- `apps/web/src/routes/_modules/shell/app-rail.tsx` — rail destinations.
- `apps/web/src/routes/_modules/shell/admin-shell.tsx` — shell sections and mobile panes.
- `apps/web/src/routes/_modules/shell/chat-tree.tsx` — chat/session rows and row actions.
- `apps/web/src/routes/(messaging)/_modules/session-inspector-sidebar.tsx` — inspector tabs.
- `docs/architecture/workspace-and-hooks.md` — prompt-hook and workspace semantics.
- `docs/architecture/startup-lifecycle.md` — recovery ordering and readiness.
- `docs/architecture/database.md` — domain/plugin database boundaries.
