PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_persona_bindings` (
	`chat_kind` text,
	`chat_object_id` text,
	`conversation_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`is_global` integer NOT NULL,
	`persona_id` text NOT NULL,
	FOREIGN KEY (`chat_object_id`) REFERENCES `chat_objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_persona_bindings`("chat_kind", "chat_object_id", "conversation_id", "created_at", "id", "is_active", "is_global", "persona_id") SELECT "chat_kind", "chat_object_id", "conversation_id", "created_at", "id", "is_active", "is_global", "persona_id" FROM `persona_bindings`;--> statement-breakpoint
DROP TABLE `persona_bindings`;--> statement-breakpoint
ALTER TABLE `__new_persona_bindings` RENAME TO `persona_bindings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `persona_bindings_target_idx` ON `persona_bindings` (`is_active`,`is_global`,`chat_kind`,`chat_object_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `__new_personas` (
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`behavior_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text,
	`id` text NOT NULL,
	`is_active` integer DEFAULT 0 NOT NULL,
	`model_policy_id` text,
	`name` text NOT NULL,
	`prompt_json` text NOT NULL,
	`summary` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`id`, `version`)
);
--> statement-breakpoint
INSERT INTO `__new_personas`("aliases_json", "behavior_json", "created_at", "created_by", "id", "is_active", "model_policy_id", "name", "prompt_json", "summary", "version") SELECT "aliases_json", "behavior_json", "created_at", "created_by", "id", "is_active", "model_policy_id", "name", "prompt_json", "summary", "version" FROM `personas`;--> statement-breakpoint
DROP TABLE `personas`;--> statement-breakpoint
ALTER TABLE `__new_personas` RENAME TO `personas`;--> statement-breakpoint
CREATE UNIQUE INDEX `personas_id_version_unique` ON `personas` (`id`,`version`);