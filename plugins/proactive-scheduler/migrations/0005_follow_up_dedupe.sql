ALTER TABLE plugin_proactive_scheduler_tasks ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS plugin_proactive_scheduler_tasks_dedupe_idx
	ON plugin_proactive_scheduler_tasks(dedupe_key)
	WHERE dedupe_key IS NOT NULL;
