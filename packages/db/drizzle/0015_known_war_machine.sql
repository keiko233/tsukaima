CREATE TABLE `plugin_follow_up_intents` (
	`conversation_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`delay_ms` integer NOT NULL,
	`follow_up_kind` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`scheduled_for_ms` integer NOT NULL,
	`source_task_id` text,
	`status` text NOT NULL,
	`submission_request_id` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_follow_up_intents_status_idx` ON `plugin_follow_up_intents` (`status`,`scheduled_for_ms`);--> statement-breakpoint
CREATE INDEX `plugin_follow_up_intents_plugin_idx` ON `plugin_follow_up_intents` (`plugin_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_follow_up_intents_submission_unique` ON `plugin_follow_up_intents` (`plugin_id`,`submission_request_id`);--> statement-breakpoint
CREATE TABLE `reply_dispatch_expectations` (
	`conversation_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`durable_entry_id` text,
	`kind` text NOT NULL,
	`last_detail` text,
	`state` text NOT NULL,
	`submission_request_id` text NOT NULL,
	`source_plugin_id` text,
	`source_task_id` text,
	`source_follow_up_kind` text,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `submission_request_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reply_dispatch_expectations_state_idx` ON `reply_dispatch_expectations` (`state`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `reply_dispatch_intents` (
	`claimed_at_ms` integer NOT NULL,
	`conversation_id` text NOT NULL,
	`durable_entry_id` text NOT NULL,
	`message_id` text,
	`state` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `durable_entry_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reply_dispatch_intents_state_idx` ON `reply_dispatch_intents` (`state`,`claimed_at_ms`);--> statement-breakpoint
ALTER TABLE `coding_deployments` ADD `applied_identity_json` text;--> statement-breakpoint
ALTER TABLE `coding_deployments` ADD `previous_identity_json` text;