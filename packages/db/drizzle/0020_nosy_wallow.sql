CREATE TABLE `social_profiles` (
	`active_hours_json` text DEFAULT '{}' NOT NULL,
	`conversation_id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`day_key` text,
	`interactions` integer DEFAULT 0 NOT NULL,
	`level` text DEFAULT 'L0' NOT NULL,
	`other_first` integer DEFAULT 0 NOT NULL,
	`proactive_answered` integer DEFAULT 0 NOT NULL,
	`proactive_sent` integer DEFAULT 0 NOT NULL,
	`proactive_today` integer DEFAULT 0 NOT NULL,
	`refused_at` integer,
	`refused_count` integer DEFAULT 0 NOT NULL,
	`self_first` integer DEFAULT 0 NOT NULL,
	`silent_until` integer,
	`unanswered_at` integer,
	`unanswered_streak` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`warm` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_profiles_level_idx` ON `social_profiles` (`level`,`silent_until`);