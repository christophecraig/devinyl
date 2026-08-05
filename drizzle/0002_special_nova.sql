ALTER TABLE `quiz` ADD `choice_retry_mode` text DEFAULT 'oneShot' NOT NULL;--> statement-breakpoint
ALTER TABLE `quiz` ADD `choice_retry_penalty_seconds` integer DEFAULT 3 NOT NULL;