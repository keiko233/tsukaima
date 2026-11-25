CREATE TABLE `conversation_run_segments` (
	`conversation_id` text NOT NULL,
	`duration_ms` integer,
	`ended_at` text,
	`failure_detail` text,
	`final_message_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`rounds_json` text DEFAULT '[]' NOT NULL,
	`run_id` text NOT NULL,
	`segment_index` integer NOT NULL,
	`seq` integer NOT NULL,
	`started_at` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`trigger_kind` text DEFAULT 'initial' NOT NULL,
	`trigger_message_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `conversation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_run_segments_run_index_unique` ON `conversation_run_segments` (`run_id`,`segment_index`);--> statement-breakpoint
CREATE INDEX `conversation_run_segments_conversation_seq_idx` ON `conversation_run_segments` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `conversation_runs` (
	`conversation_id` text NOT NULL,
	`duration_ms` integer,
	`durable_run_key` text,
	`ended_at` text,
	`failure_detail` text,
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`started_at` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`trigger_message_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_runs_conversation_seq_idx` ON `conversation_runs` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `conversation_runs_durable_key_idx` ON `conversation_runs` (`conversation_id`,`durable_run_key`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `next_seq` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `delivery_mode` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `segment_index` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_conversation_seq_idx` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_run_idx` ON `messages` (`run_id`);