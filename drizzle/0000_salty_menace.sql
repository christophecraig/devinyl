CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_account_user` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_provider` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `challenge` (
	`token` text PRIMARY KEY NOT NULL,
	`quiz_id` text NOT NULL,
	`creator_user_id` text,
	`creator_guest_nickname` text,
	`creator_session_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`quiz_id`) REFERENCES `quiz`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_challenge_quiz` ON `challenge` (`quiz_id`);--> statement-breakpoint
CREATE TABLE `daily_guest_claim` (
	`day` text NOT NULL,
	`ip_hash` text NOT NULL,
	`guest_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`day`, `ip_hash`)
);
--> statement-breakpoint
CREATE INDEX `idx_claim_created` ON `daily_guest_claim` (`created_at`);--> statement-breakpoint
CREATE TABLE `daily_quiz` (
	`day` text PRIMARY KEY NOT NULL,
	`quiz_id` text NOT NULL,
	`day_number` integer NOT NULL,
	FOREIGN KEY (`quiz_id`) REFERENCES `quiz`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_quiz_day_number_unique` ON `daily_quiz` (`day_number`);--> statement-breakpoint
CREATE TABLE `friendship` (
	`a_user_id` text NOT NULL,
	`b_user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`a_user_id`, `b_user_id`),
	FOREIGN KEY (`a_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`b_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_friendship_b` ON `friendship` (`b_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `game_session` (
	`id` text PRIMARY KEY NOT NULL,
	`quiz_id` text NOT NULL,
	`challenge_token` text,
	`daily_day` text,
	`user_id` text,
	`guest_id` text,
	`nickname` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`scored` integer DEFAULT false NOT NULL,
	`scored_block_reason` text,
	`curve_version` integer DEFAULT 1 NOT NULL,
	`effective_scoring_mode` text NOT NULL,
	`total_score` integer,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finalized_at` integer,
	`server_round_log` text DEFAULT '[]',
	FOREIGN KEY (`quiz_id`) REFERENCES `quiz`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenge_token`) REFERENCES `challenge`(`token`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_gs_board` ON `game_session` (`quiz_id`,`effective_scoring_mode`,`scored`,`total_score`,`finalized_at`);--> statement-breakpoint
CREATE INDEX `idx_gs_challenge` ON `game_session` (`challenge_token`,`effective_scoring_mode`,`scored`,`total_score`,`finalized_at`);--> statement-breakpoint
CREATE INDEX `idx_gs_daily` ON `game_session` (`daily_day`,`effective_scoring_mode`,`scored`,`total_score`,`finalized_at`);--> statement-breakpoint
CREATE INDEX `idx_gs_player_user` ON `game_session` (`user_id`,`quiz_id`);--> statement-breakpoint
CREATE INDEX `idx_gs_player_guest` ON `game_session` (`guest_id`,`quiz_id`);--> statement-breakpoint
CREATE INDEX `idx_gs_status` ON `game_session` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `imported_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`quiz_id` text,
	`quiz_name` text,
	`total_score` integer DEFAULT 0 NOT NULL,
	`rounds` integer DEFAULT 0 NOT NULL,
	`is_daily` integer DEFAULT false NOT NULL,
	`played_at` integer NOT NULL,
	`imported` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quiz_id`) REFERENCES `quiz`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_imported_user` ON `imported_history` (`user_id`,`played_at`);--> statement-breakpoint
CREATE TABLE `metrics_daily` (
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `metric`)
);
--> statement-breakpoint
CREATE TABLE `quiz` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`name_fr` text,
	`name_en` text,
	`description_fr` text,
	`description_en` text,
	`guess_target` text DEFAULT 'both' NOT NULL,
	`answer_mode` text DEFAULT 'text' NOT NULL,
	`scoring_mode` text DEFAULT 'speed' NOT NULL,
	`curve_version` integer DEFAULT 1 NOT NULL,
	`ephemeral_until` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_quiz_owner` ON `quiz` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_quiz_kind` ON `quiz` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_quiz_ephemeral` ON `quiz` (`ephemeral_until`);--> statement-breakpoint
CREATE TABLE `quiz_track` (
	`quiz_id` text NOT NULL,
	`position` integer NOT NULL,
	`track_id` text NOT NULL,
	`choices` text,
	PRIMARY KEY(`quiz_id`, `position`),
	FOREIGN KEY (`quiz_id`) REFERENCES `quiz`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `track_cache`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_quiz_track_track` ON `quiz_track` (`track_id`);--> statement-breakpoint
CREATE TABLE `round_result` (
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`title_ok` integer,
	`artist_ok` integer,
	`skipped` integer DEFAULT false NOT NULL,
	`clip_ms` integer NOT NULL,
	`title_ms` integer,
	`artist_ms` integer,
	`points` integer DEFAULT 0 NOT NULL,
	`guess_log` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`session_id`, `position`),
	FOREIGN KEY (`session_id`) REFERENCES `game_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_token` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `idx_session_user` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `share_event` (
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `track_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'deezer' NOT NULL,
	`provider_track_id` text NOT NULL,
	`title` text NOT NULL,
	`title_short` text NOT NULL,
	`artists` text NOT NULL,
	`album_title` text,
	`cover_url` text,
	`release_year` integer,
	`genre` text,
	`decade` integer,
	`answers` text NOT NULL,
	`preview_ms` integer,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`unavailable_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_track_genre_decade` ON `track_cache` (`genre`,`decade`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_track_provider` ON `track_cache` (`provider`,`provider_track_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`display_name` text NOT NULL,
	`display_name_normalized` text NOT NULL,
	`avatar_url` text,
	`locale` text DEFAULT 'fr' NOT NULL,
	`birth_year` integer,
	`extended_input` integer DEFAULT false NOT NULL,
	`is_operator` integer DEFAULT false NOT NULL,
	`deleted_email_hash` text,
	`deleted_email_hash_expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_email` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_display_name_normalized` ON `user` (`display_name_normalized`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_verification_identifier` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `weekly_points` (
	`user_id` text NOT NULL,
	`week` text NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `week`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_weekly_week` ON `weekly_points` (`week`,`points`);--> statement-breakpoint
CREATE TABLE `weekly_rank_snapshot` (
	`user_id` text NOT NULL,
	`week` text NOT NULL,
	`rank` integer NOT NULL,
	`points` integer NOT NULL,
	PRIMARY KEY(`user_id`, `week`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
