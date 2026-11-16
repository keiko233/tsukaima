CREATE TABLE `runtime_upgrades` (
	`ahead` integer DEFAULT 0 NOT NULL,
	`auto_finalize` integer DEFAULT true NOT NULL,
	`behind` integer DEFAULT 0 NOT NULL,
	`branch` text NOT NULL,
	`completed_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`current_commit` text NOT NULL,
	`current_version` text NOT NULL,
	`error` text,
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`remote` text NOT NULL,
	`restart_id` text,
	`status` text NOT NULL,
	`target_commit` text NOT NULL,
	`target_version` text NOT NULL,
	`task_id` text,
	`updated_at_ms` integer NOT NULL,
	`upstream_ref` text NOT NULL,
	`workspace_session_id` text,
	`worktree_path` text
);
--> statement-breakpoint
CREATE INDEX `runtime_upgrades_status_idx` ON `runtime_upgrades` (`status`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `runtime_upgrades_created_idx` ON `runtime_upgrades` (`created_at_ms`);