CREATE TABLE `prompt_hooks` (
	`after_restart` integer DEFAULT false NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text NOT NULL,
	`dedupe_key` text,
	`deliver_at_ms` integer,
	`expires_at_ms` integer,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`last_error` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`prompt` text NOT NULL,
	`source_session_id` text,
	`starts_at_ms` integer NOT NULL,
	`status` text NOT NULL,
	`target_session_id` text,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`source_session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_hooks_dedupe_unique` ON `prompt_hooks` (`dedupe_key`) WHERE "prompt_hooks"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `prompt_hooks_target_idx` ON `prompt_hooks` (`target_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `prompt_hooks_delivery_idx` ON `prompt_hooks` (`status`,`deliver_at_ms`);--> statement-breakpoint
CREATE TABLE `runtime_restarts` (
	`completed_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`execute_at_ms` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`mode` text NOT NULL,
	`reason` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runtime_restarts_status_idx` ON `runtime_restarts` (`status`,`execute_at_ms`);--> statement-breakpoint
CREATE TABLE `workspace_sessions` (
	`base_ref` text NOT NULL,
	`chat_object_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`goal` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`parent_session_id` text,
	`repository_root` text NOT NULL,
	`task_id` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`chat_object_id`) REFERENCES `chat_objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `coding_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_sessions_task_idx` ON `workspace_sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX `workspace_sessions_parent_idx` ON `workspace_sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `workspace_sessions_recent_idx` ON `workspace_sessions` (`updated_at_ms`);