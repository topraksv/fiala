CREATE TABLE `package_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`package_id` text NOT NULL,
	`changes` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_package_changes_package_id` ON `package_changes` (`package_id`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`thumb` text NOT NULL,
	`created_at` text NOT NULL,
	`uploaded_at` text
);
--> statement-breakpoint
ALTER TABLE `packages` ADD `warn_days` integer;--> statement-breakpoint
ALTER TABLE `packages` ADD `photo_id` text;--> statement-breakpoint
ALTER TABLE `people` ADD `color` text;--> statement-breakpoint
ALTER TABLE `people` ADD `warn_days` integer;--> statement-breakpoint
ALTER TABLE `people` ADD `photo_id` text;--> statement-breakpoint
ALTER TABLE `products` ADD `wanted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `photo_id` text;--> statement-breakpoint
ALTER TABLE `locations` DROP COLUMN `sort_order`;