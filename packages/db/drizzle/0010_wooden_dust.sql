CREATE TABLE `coding_deployments` (
	`artifact_metadata_json` text,
	`created_at_ms` integer NOT NULL,
	`created_by` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`post_check_json` text,
	`pre_check_json` text,
	`proposal_id` text NOT NULL,
	`reloaded_at_ms` integer,
	`rollback_of_id` text,
	`rollback_plan` text NOT NULL,
	`source_revision` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coding_deployments_proposal_idx` ON `coding_deployments` (`proposal_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `coding_deployments_task_idx` ON `coding_deployments` (`task_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `coding_deployments_status_idx` ON `coding_deployments` (`status`,`updated_at_ms`);--> statement-breakpoint
CREATE TABLE `coding_tasks` (
	`artifacts_json` text DEFAULT '[]' NOT NULL,
	`base_ref` text NOT NULL,
	`constraints_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`goal` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`logs_json` text DEFAULT '[]' NOT NULL,
	`mode` text NOT NULL,
	`source_conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`timeline_json` text DEFAULT '[]' NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`worktree_path` text
);
--> statement-breakpoint
CREATE INDEX `coding_tasks_status_idx` ON `coding_tasks` (`status`,`updated_at_ms`);--> statement-breakpoint
CREATE INDEX `coding_tasks_conversation_idx` ON `coding_tasks` (`source_conversation_id`,`updated_at_ms`);--> statement-breakpoint
ALTER TABLE `coding_proposals` ADD `artifact_metadata_json` text;--> statement-breakpoint
ALTER TABLE `coding_proposals` ADD `changed_files_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `coding_proposals` ADD `diff_checksum` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `coding_proposals` ADD `env_changes_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `coding_proposals` ADD `motivation` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `coding_proposals` ADD `requires_restart` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `coding_proposals` ADD `source_revision` text DEFAULT '' NOT NULL;