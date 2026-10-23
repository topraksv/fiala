CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `package_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`package_id` text NOT NULL,
	`quantity_milli` integer NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_package_moves_package_id` ON `package_moves` (`package_id`);--> statement-breakpoint
CREATE TABLE `packages` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`product_id` text NOT NULL,
	`person_id` text,
	`location_id` text,
	`unit` text NOT NULL,
	`expires_on` text,
	`opened_on` text,
	`use_within_days` integer,
	`low_milli` integer,
	`serial` text,
	`lot` text,
	`nickname` text,
	`acquired_on` text,
	`acquired_from` text,
	`note` text,
	`disposition` text
);
--> statement-breakpoint
CREATE INDEX `idx_packages_product_id` ON `packages` (`product_id`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'person' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`product_id` text NOT NULL,
	`tag_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_product_tags_product_id` ON `product_tags` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`active_substance` text,
	`strength` text,
	`form` text,
	`pack` text,
	`manufacturer` text,
	`gtin` text,
	`note` text,
	`starred` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`name` text NOT NULL
);
