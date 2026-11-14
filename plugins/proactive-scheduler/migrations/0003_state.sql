CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_state (
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
);
