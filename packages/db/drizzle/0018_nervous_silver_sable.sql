CREATE TABLE `chat_snapshots` (
	`applied_at` text,
	`conversation_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	`durable_conversation_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`purpose` text DEFAULT 'checkpoint' NOT NULL,
	`restored_from_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`title` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_snapshots_conversation_idx` ON `chat_snapshots` (`conversation_id`,`created_at`);