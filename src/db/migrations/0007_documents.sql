CREATE TABLE `document_files` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`uploaded_at` text
);
--> statement-breakpoint
CREATE TABLE `document_links` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`document_id` text NOT NULL,
	`product_id` text,
	`package_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_document_links_document_id` ON `document_links` (`document_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`tombstone_version` integer DEFAULT 0 NOT NULL,
	`cabinet_id` text NOT NULL,
	`person_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`issued_on` text,
	`note` text,
	`reference` text,
	`file_id` text,
	`file_type` text,
	`byte_size` integer,
	`archived` integer DEFAULT false NOT NULL,
	`created_by` text
);
