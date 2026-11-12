CREATE TABLE `chat_objects` (
	`channel_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`muted` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`platform_conversation_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`title` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_objects_recent_idx` ON `chat_objects` (`status`,`pinned`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_objects_channel_platform_unique` ON `chat_objects` (`channel_id`,`kind`,`platform_conversation_id`);--> statement-breakpoint
CREATE TABLE `requests` (
	`account_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`comment` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`error_message` text,
	`flag` text NOT NULL,
	`group_external_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`raw_json` text,
	`requester_display_name` text,
	`requester_external_id` text NOT NULL,
	`resolution_action` text,
	`resolution_reason` text,
	`resolved_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`sub_type` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `requests_status_time_idx` ON `requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_group_idx` ON `requests` (`group_external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `requests_channel_flag_unique` ON `requests` (`channel_id`,`flag`);--> statement-breakpoint
DROP INDEX `conversations_channel_platform_unique`;--> statement-breakpoint
ALTER TABLE `conversations` ADD `chat_object_id` text REFERENCES chat_objects(id);--> statement-breakpoint
ALTER TABLE `conversations` ADD `is_receiving` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO `chat_objects` (
	`channel_id`,
	`created_at`,
	`id`,
	`kind`,
	`platform_conversation_id`,
	`status`,
	`title`,
	`updated_at`
)
SELECT
	`channel_id`,
	`created_at`,
	'chat_' || `id`,
	`kind`,
	`platform_conversation_id`,
	CASE WHEN `status` = 'archived' THEN 'archived' ELSE 'active' END,
	COALESCE(`title`, `kind` || ' ' || COALESCE(`platform_conversation_id`, `id`)),
	`updated_at`
FROM `conversations`;--> statement-breakpoint
UPDATE `conversations` SET `chat_object_id` = 'chat_' || `id`, `is_receiving` = 1;--> statement-breakpoint
CREATE INDEX `conversations_chat_idx` ON `conversations` (`chat_object_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_one_receiving_unique` ON `conversations` (`chat_object_id`) WHERE "conversations"."is_receiving" = 1;--> statement-breakpoint
ALTER TABLE `messages` ADD `chat_object_id` text REFERENCES chat_objects(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `content_text` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `delivery_status` text DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `parts_json` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to_message_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_display_name` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_external_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `updated_at` text;--> statement-breakpoint
UPDATE `messages` SET `updated_at` = `ingested_at`;--> statement-breakpoint
UPDATE `messages`
SET `chat_object_id` = (
	SELECT `conversations`.`chat_object_id`
	FROM `conversations`
	WHERE `conversations`.`id` = `messages`.`conversation_id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_platform_unique` ON `messages` (`chat_object_id`,`platform_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_durable_entry_unique` ON `messages` (`conversation_id`,`durable_entry_id`);
