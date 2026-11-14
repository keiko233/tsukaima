CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_decisions (
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
	ON plugin_proactive_scheduler_decisions(conversation_id, created_at_ms);
