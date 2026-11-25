ALTER TABLE `workspace_sessions` ADD `sandbox_path` text;--> statement-breakpoint
ALTER TABLE `workspace_sessions` ADD `workspace_kind` text DEFAULT 'coding' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_sessions` ADD `owner_user_id` text;