CREATE TABLE `schedule_occurrences` (
	`attempt` integer DEFAULT 0 NOT NULL,
	`available_at_ms` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`error` text,
	`finished_at_ms` integer,
	`id` text PRIMARY KEY NOT NULL,
	`lease_expires_at_ms` integer,
	`lease_owner` text,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`message_id` text,
	`occurrence_key` text NOT NULL,
	`result_json` text,
	`schedule_id` text NOT NULL,
	`schedule_revision` integer NOT NULL,
	`scheduled_for_ms` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`started_at_ms` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`submission_request_id` text,
	`trigger_kind` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_occurrences_key_unique` ON `schedule_occurrences` (`schedule_id`,`occurrence_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_occurrences_scheduled_unique` ON `schedule_occurrences` (`schedule_id`,`scheduled_for_ms`) WHERE "schedule_occurrences"."trigger_kind" = 'scheduled';--> statement-breakpoint
CREATE INDEX `schedule_occurrences_claim_idx` ON `schedule_occurrences` (`status`,`available_at_ms`);--> statement-breakpoint
CREATE INDEX `schedule_occurrences_lease_idx` ON `schedule_occurrences` (`status`,`lease_expires_at_ms`);--> statement-breakpoint
CREATE INDEX `schedule_occurrences_schedule_idx` ON `schedule_occurrences` (`schedule_id`,`scheduled_for_ms`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`action_kind` text NOT NULL,
	`cancelled_at_ms` integer,
	`catch_up` text NOT NULL,
	`completed_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`dedupe_key` text,
	`grace_ms` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_run_at_ms` integer,
	`max_attempts` integer NOT NULL,
	`max_runs` integer,
	`next_run_at_ms` integer,
	`owner_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_plugin_id` text,
	`paused_at_ms` integer,
	`prompt` text NOT NULL,
	`recurrence_json` text NOT NULL,
	`recurrence_kind` text NOT NULL,
	`respect_quiet_hours` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`target_chat_object_id` text,
	`target_session_id` text NOT NULL,
	`time_zone` text NOT NULL,
	`title` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`target_chat_object_id`) REFERENCES `chat_objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_session_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedules_due_idx` ON `schedules` (`status`,`next_run_at_ms`);--> statement-breakpoint
CREATE INDEX `schedules_target_idx` ON `schedules` (`target_session_id`,`status`,`next_run_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_dedupe_unique` ON `schedules` (`dedupe_key`) WHERE "schedules"."dedupe_key" IS NOT NULL;