import { pluginManifestSchema, type PluginManifest } from "@elaina/sdk";

export const PROACTIVE_SCHEDULER_PLUGIN_ID = "proactive-scheduler";
export const PROACTIVE_SCHEDULER_RPC_PREFIX = `${PROACTIVE_SCHEDULER_PLUGIN_ID}.`;
export const PROACTIVE_SCHEDULER_RUN_KIND = "proactive-scheduler.run";
export const PROACTIVE_SCHEDULER_TICK_KIND = "proactive-scheduler.tick";
export const PROACTIVE_SCHEDULER_TICK_DEDUPE_KEY = "proactive-scheduler.tick";
export const PROACTIVE_SCHEDULER_TABLE_PREFIX = "plugin_proactive_scheduler_";

const MIGRATIONS = [
	{
		rollbackSql:
			"DROP INDEX IF EXISTS plugin_proactive_scheduler_tasks_conversation_idx; DROP INDEX IF EXISTS plugin_proactive_scheduler_tasks_status_idx; DROP TABLE IF EXISTS plugin_proactive_scheduler_tasks;",
		sql: `CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_tasks (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL DEFAULT '',
	conversation_id TEXT NOT NULL,
	chat_object_id TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('remind', 'nudge', 'proactive', 'workflow')),
	prompt TEXT NOT NULL,
	scheduled_for_ms INTEGER NOT NULL,
	due_window_ms INTEGER,
	repeat_json TEXT NOT NULL DEFAULT 'null',
	cancel_if_replied INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	attempts INTEGER NOT NULL DEFAULT 0,
	occurrences INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'cancelled', 'failed', 'skipped')),
	last_error TEXT,
	created_by_kind TEXT NOT NULL,
	created_by_id TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_proactive_scheduler_tasks_status_idx
	ON plugin_proactive_scheduler_tasks(status, scheduled_for_ms);
CREATE INDEX IF NOT EXISTS plugin_proactive_scheduler_tasks_conversation_idx
	ON plugin_proactive_scheduler_tasks(conversation_id, status);`,
		version: "1",
	},
	{
		rollbackSql: "DROP TABLE IF EXISTS plugin_proactive_scheduler_policies;",
		sql: `CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_policies (
	id TEXT PRIMARY KEY,
	scope TEXT NOT NULL CHECK (scope IN ('global', 'conversation', 'persona')),
	scope_id TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 0,
	allow_remind INTEGER NOT NULL DEFAULT 1,
	allow_nudge INTEGER NOT NULL DEFAULT 1,
	allow_proactive INTEGER NOT NULL DEFAULT 1,
	quiet_hours_json TEXT NOT NULL DEFAULT '{"enabled":false,"ranges":[],"timezoneOffsetMinutes":0}',
	daily_cap INTEGER NOT NULL DEFAULT 5,
	hourly_cap INTEGER NOT NULL DEFAULT 2,
	cooldown_ms INTEGER NOT NULL DEFAULT 900000,
	backoff_ms INTEGER NOT NULL DEFAULT 600000,
	min_messages INTEGER NOT NULL DEFAULT 3,
	min_idle_ms INTEGER NOT NULL DEFAULT 1200000,
	max_idle_ms INTEGER NOT NULL DEFAULT 21600000,
	min_warmness REAL NOT NULL DEFAULT 0.25,
	probability REAL NOT NULL DEFAULT 0.15,
	bubble_gate INTEGER NOT NULL DEFAULT 0,
	max_delay_ms INTEGER NOT NULL DEFAULT 86400000,
	max_pending_per_conversation INTEGER NOT NULL DEFAULT 10,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	UNIQUE (scope, scope_id)
);`,
		version: "2",
	},
	{
		rollbackSql: "DROP TABLE IF EXISTS plugin_proactive_scheduler_state;",
		sql: `CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_state (
	conversation_id TEXT PRIMARY KEY,
	last_message_at_ms INTEGER,
	last_inbound_at_ms INTEGER,
	last_outbound_at_ms INTEGER,
	inbound_count INTEGER NOT NULL DEFAULT 0,
	unanswered_streak INTEGER NOT NULL DEFAULT 0,
	refused_count INTEGER NOT NULL DEFAULT 0,
	silence_until_ms INTEGER,
	active_hours_histogram_json TEXT NOT NULL DEFAULT '{}',
	warmness REAL NOT NULL DEFAULT 0,
	openers_json TEXT NOT NULL DEFAULT '[]',
	daily_count_date TEXT,
	daily_count INTEGER NOT NULL DEFAULT 0,
	hourly_window_ms INTEGER,
	hourly_count INTEGER NOT NULL DEFAULT 0,
	updated_at_ms INTEGER NOT NULL
);`,
		version: "3",
	},
	{
		rollbackSql:
			"DROP INDEX IF EXISTS plugin_proactive_scheduler_decisions_conversation_idx; DROP TABLE IF EXISTS plugin_proactive_scheduler_decisions;",
		sql: `CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_decisions (
	id TEXT PRIMARY KEY,
	task_id TEXT,
	kind TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	gate_json TEXT NOT NULL DEFAULT '[]',
	gate_result TEXT NOT NULL,
	marker TEXT,
	delivery_status TEXT,
	skipped_reason TEXT,
	created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_proactive_scheduler_decisions_conversation_idx
	ON plugin_proactive_scheduler_decisions(conversation_id, created_at_ms);`,
		version: "4",
	},
] as const;

export const proactiveSchedulerManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configSchema: {
		properties: {
			maxPromptChars: { type: "integer" },
			tickIntervalMs: { type: "integer" },
		},
		type: "object",
	},
	hooks: [{ name: "message.received" }, { name: "after.reply" }],
	kind: "builtin",
	migrations: MIGRATIONS.map((migration) => ({ ...migration })),
	name: PROACTIVE_SCHEDULER_PLUGIN_ID,
	permissions: [
		"ui.panel",
		"tools",
		"audit.write",
		"storage.global",
		"tasks.create",
		"tasks.get",
		"tasks.list",
		"tasks.cancel",
		"tasks.watch",
		"conversation.read",
		"channel.send",
	],
	version: "0.1.0",
});
