CREATE TABLE `memory_consolidation_state` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`dropped_batches` integer DEFAULT 0 NOT NULL,
	`failed_batch_key` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_run_at` text,
	`pending_messages` integer DEFAULT 0 NOT NULL,
	`pending_since` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`watermark_message_id` text,
	`watermark_occurred_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_sender_time_idx` ON `messages` (`sender_user_id`,`occurred_at`);