CREATE TABLE `flight_request` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_flight_request_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_flight_request_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `flight_request_session_time_created_id_idx` ON `flight_request` (`session_id`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `flight_request_message_id_idx` ON `flight_request` (`message_id`);--> statement-breakpoint
CREATE INDEX `part_session_flight_step_idx` ON `part` (`session_id`,`time_created`,`id`) WHERE json_extract("part"."data", '$.type') = 'step-finish';