CREATE TABLE `dose_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`due_on` text NOT NULL,
	`due_time` text NOT NULL,
	`status` text NOT NULL,
	`snoozed_until` text,
	`move_id` text,
	`answered_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_dose_logs_plan_id` ON `dose_logs` (`plan_id`);--> statement-breakpoint
CREATE TABLE `dose_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`product_id` text NOT NULL,
	`package_id` text,
	`person_id` text,
	`amount_milli` integer NOT NULL,
	`times` text NOT NULL,
	`weekdays` integer NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`instructions` text,
	`paused` integer DEFAULT false NOT NULL,
	`created_by` text
);
