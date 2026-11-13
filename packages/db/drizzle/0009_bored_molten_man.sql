ALTER TABLE `memories` ADD `dedupe_key` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `embedding_json` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `embedding_model` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `evidence_json` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `extraction_model` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `extraction_prompt_version` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `pinned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `source_message_id` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX `memories_status_scope_expiry_idx` ON `memories` (`status`,`scope`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `memories_dedupe_key_unique` ON `memories` (`dedupe_key`) WHERE "memories"."dedupe_key" IS NOT NULL;