CREATE TABLE `plugin_install_states` (
	`backup_json` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`installed_version` text NOT NULL,
	`kind` text NOT NULL,
	`manifest_json` text NOT NULL,
	`plugin_id` text PRIMARY KEY NOT NULL,
	`quarantine_reason` text,
	`quarantined_at` text,
	`retain_data` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugin_kv_storage` (
	`key` text NOT NULL,
	`plugin_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_key` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plugin_kv_storage_plugin_idx` ON `plugin_kv_storage` (`plugin_id`,`scope`,`scope_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_kv_storage_unique` ON `plugin_kv_storage` (`plugin_id`,`scope`,`scope_key`,`key`);--> statement-breakpoint
CREATE TABLE `plugin_migrations` (
	`applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`checksum` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`rollback_sql` text,
	`status` text DEFAULT 'applied' NOT NULL,
	`version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plugin_migrations_plugin_idx` ON `plugin_migrations` (`plugin_id`,`applied_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_migrations_plugin_version_unique` ON `plugin_migrations` (`plugin_id`,`version`);--> statement-breakpoint
CREATE TABLE `plugin_tasks` (
	`attempts` integer DEFAULT 0 NOT NULL,
	`chat_object_id` text,
	`conversation_id` text,
	`created_at_ms` integer NOT NULL,
	`dedupe_key` text,
	`id` text PRIMARY KEY NOT NULL,
	`interval_ms` integer,
	`kind` text NOT NULL,
	`logs_json` text DEFAULT '[]' NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`next_run_at_ms` integer NOT NULL,
	`outcome_json` text,
	`payload_json` text,
	`permissions_json` text DEFAULT '[]' NOT NULL,
	`plugin_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`chat_object_id`) REFERENCES `chat_objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `plugin_tasks_due_idx` ON `plugin_tasks` (`status`,`next_run_at_ms`);--> statement-breakpoint
CREATE INDEX `plugin_tasks_plugin_dedupe_idx` ON `plugin_tasks` (`plugin_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `plugin_tasks_plugin_status_idx` ON `plugin_tasks` (`plugin_id`,`status`);