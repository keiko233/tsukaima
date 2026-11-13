ALTER TABLE `messages` ADD `trigger_classification` text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE `persona_bindings` ADD `chat_kind` text;--> statement-breakpoint
ALTER TABLE `persona_bindings` ADD `chat_object_id` text REFERENCES chat_objects(id);--> statement-breakpoint
CREATE INDEX `persona_bindings_target_idx` ON `persona_bindings` (`is_active`,`is_global`,`chat_kind`,`chat_object_id`,`conversation_id`);--> statement-breakpoint
ALTER TABLE `personas` ADD `aliases_json` text DEFAULT '[]' NOT NULL;