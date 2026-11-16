CREATE TABLE `workspace_references` (
	`created_at_ms` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`source_session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_session_id`) REFERENCES `workspace_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_references_source_idx` ON `workspace_references` (`source_session_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `workspace_references_target_idx` ON `workspace_references` (`target_session_id`);--> statement-breakpoint
CREATE TABLE `workspace_todos` (
	`content` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`sort_order` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`workspace_session_id` text NOT NULL,
	FOREIGN KEY (`workspace_session_id`) REFERENCES `workspace_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workspace_todos_workspace_idx` ON `workspace_todos` (`workspace_session_id`,`sort_order`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace_sessions` (
	`base_ref` text NOT NULL,
	`chat_object_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`goal` text,
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`parent_session_id` text,
	`repository_root` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`task_id` text,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`chat_object_id`) REFERENCES `chat_objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `coding_tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_workspace_sessions`("base_ref", "chat_object_id", "created_at_ms", "goal", "id", "mode", "parent_session_id", "repository_root", "tags_json", "task_id", "updated_at_ms") SELECT "base_ref", "chat_object_id", "created_at_ms", "goal", "id", "mode", "parent_session_id", "repository_root", "tags_json", "task_id", "updated_at_ms" FROM `workspace_sessions`;--> statement-breakpoint
DROP TABLE `workspace_sessions`;--> statement-breakpoint
ALTER TABLE `__new_workspace_sessions` RENAME TO `workspace_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `workspace_sessions_task_idx` ON `workspace_sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX `workspace_sessions_parent_idx` ON `workspace_sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `workspace_sessions_recent_idx` ON `workspace_sessions` (`updated_at_ms`);