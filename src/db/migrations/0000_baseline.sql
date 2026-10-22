CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`op` text DEFAULT 'upsert' NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_idempotency_key_unique` ON `outbox` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_outbox_table_id` ON `outbox` (`table_name`,`id`);--> statement-breakpoint
CREATE INDEX `idx_outbox_table_row_id_id` ON `outbox` (`table_name`,`row_id`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_dead_letters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`outbox_id` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`payload` text NOT NULL,
	`reason` text NOT NULL,
	`quarantined_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_dead_letters_outbox_id_unique` ON `sync_dead_letters` (`outbox_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`table_name` text PRIMARY KEY NOT NULL,
	`last_pulled_at` text NOT NULL
);
