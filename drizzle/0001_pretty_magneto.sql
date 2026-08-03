CREATE TABLE `rate_limit` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `idx_rate_limit_window` ON `rate_limit` (`window_start`);--> statement-breakpoint
ALTER TABLE `round_result` ADD `claimed_title_ms` integer;--> statement-breakpoint
ALTER TABLE `round_result` ADD `claimed_artist_ms` integer;--> statement-breakpoint
ALTER TABLE `round_result` ADD `server_received_at` integer;