CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` text NOT NULL,
	`closed_at` text,
	`model_context_json` text,
	`summary` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `activities_conversation_idx` ON `activities` (`conversation_id`,`opened_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `activities_conversation_trigger_unique` ON `activities` (`conversation_id`,`trigger_message_id`);--> statement-breakpoint
CREATE TABLE `activity_messages` (
	`activity_id` text NOT NULL,
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`activity_id`, `message_id`),
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text,
	`result` text NOT NULL,
	`reason` text,
	`payload_json` text
);
--> statement-breakpoint
CREATE INDEX `audit_time_idx` ON `audit_log` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`platform_role` text,
	`joined_at` text,
	`last_seen_at` text,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`durable_conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel_id` text,
	`platform_conversation_id` text,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_channel_idx` ON `conversations` (`channel_id`,`kind`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_channel_platform_unique` ON `conversations` (`channel_id`,`platform_conversation_id`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_user_id` text NOT NULL,
	`platform` text NOT NULL,
	`platform_account_id` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`raw_metadata_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`canonical_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `identities_canonical_idx` ON `identities` (`canonical_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `identities_platform_unique` ON `identities` (`platform`,`platform_account_id`,`external_id`,`kind`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject_user_id` text,
	`conversation_id` text,
	`project_id` text,
	`content` text NOT NULL,
	`summary` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`importance` real DEFAULT 0.5 NOT NULL,
	`source_conversation_id` text,
	`source_entry_id` text,
	`source_activity_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_scope_idx` ON `memories` (`scope`,`subject_user_id`,`conversation_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `memories_content_idx` ON `memories` (`summary`);--> statement-breakpoint
CREATE TABLE `memory_links` (
	`memory_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`relation` text NOT NULL,
	PRIMARY KEY(`memory_id`, `target_kind`, `target_id`, `relation`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`durable_entry_id` text,
	`sender_user_id` text,
	`platform_message_id` text,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`ingested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`is_aggregated` integer DEFAULT 0 NOT NULL,
	`activity_id` text,
	`raw_ref_json` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_time_idx` ON `messages` (`conversation_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `messages_sender_idx` ON `messages` (`sender_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_platform_unique` ON `messages` (`conversation_id`,`platform_message_id`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `migration_records` (
	`id` text PRIMARY KEY NOT NULL,
	`migration_run_id` text NOT NULL,
	`source_system` text NOT NULL,
	`source_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text,
	`status` text NOT NULL,
	`reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migration_source_unique` ON `migration_records` (`source_system`,`source_id`,`target_kind`);--> statement-breakpoint
CREATE TABLE `migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`report_json` text
);
--> statement-breakpoint
CREATE TABLE `model_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`capability` text NOT NULL,
	`primary_provider` text NOT NULL,
	`primary_model` text NOT NULL,
	`fallbacks_json` text NOT NULL,
	`thinking_level` text,
	`max_output_tokens` integer,
	`daily_budget_usd` real,
	`allowed_tools_json` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_policies_capability_unique` ON `model_policies` (`capability`);--> statement-breakpoint
CREATE TABLE `persona_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`persona_id` text NOT NULL,
	`conversation_id` text,
	`is_global` integer NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`summary` text NOT NULL,
	`prompt_json` text NOT NULL,
	`behavior_json` text NOT NULL,
	`model_policy_id` text,
	`is_active` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personas_id_version_unique` ON `personas` (`id`,`version`);--> statement-breakpoint
CREATE TABLE `plugin_grants` (
	`plugin_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted` integer DEFAULT 0 NOT NULL,
	`granted_by` text,
	`granted_at` text,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`api_version` text NOT NULL,
	`kind` text NOT NULL,
	`manifest_json` text NOT NULL,
	`config_schema_json` text,
	`config_json` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`run_mode` text NOT NULL,
	`installed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plugins_enabled_idx` ON `plugins` (`enabled`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `plugins_name_unique` ON `plugins` (`name`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`conversation_id` text,
	`policy_json` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`alias` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_aliases_user_alias_unique` ON `user_aliases` (`user_id`,`alias`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`preferred_name` text,
	`trust_level` text DEFAULT 'normal' NOT NULL,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
