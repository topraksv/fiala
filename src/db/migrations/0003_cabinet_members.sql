CREATE TABLE `cabinet_members` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`seen_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_cabinet_members_cabinet_id` ON `cabinet_members` (`cabinet_id`);--> statement-breakpoint
CREATE TABLE `cabinets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`owner_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL
);
