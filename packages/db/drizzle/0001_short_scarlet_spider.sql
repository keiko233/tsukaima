CREATE TABLE `coding_approvals` (
	`action` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`note` text,
	`proposal_id` text,
	`requested_by` text NOT NULL,
	`resolved_at_ms` integer,
	`resolved_by` text,
	`status` text NOT NULL,
	`task_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coding_approvals_status_idx` ON `coding_approvals` (`status`,`expires_at_ms`);--> statement-breakpoint
CREATE INDEX `coding_approvals_task_idx` ON `coding_approvals` (`task_id`);--> statement-breakpoint
CREATE TABLE `coding_proposals` (
	`created_at_ms` integer NOT NULL,
	`diff` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`risk_assessment` text NOT NULL,
	`rollback_notes` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text NOT NULL,
	`test_result_json` text,
	`title` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `coding_proposals_task_idx` ON `coding_proposals` (`task_id`,`updated_at_ms`);--> statement-breakpoint
CREATE INDEX `coding_proposals_status_idx` ON `coding_proposals` (`status`);