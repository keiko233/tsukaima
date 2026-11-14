CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_tasks (
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
	ON plugin_proactive_scheduler_tasks(conversation_id, status);
