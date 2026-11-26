CREATE TABLE `flight_scope` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text,
	`time_created` integer NOT NULL,
	`visible` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `flight_scope_pk` PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE INDEX `flight_scope_project_time_idx` ON `flight_scope` (`project_id`,`kind`,`visible`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `flight_scope_workspace_time_idx` ON `flight_scope` (`project_id`,`workspace_id`,`kind`,`visible`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `flight_scope_session_idx` ON `flight_scope` (`session_id`);--> statement-breakpoint
CREATE INDEX `flight_scope_message_idx` ON `flight_scope` (`message_id`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_request_insert`
AFTER INSERT ON `flight_request`
BEGIN
  INSERT OR REPLACE INTO `flight_scope` (`kind`,`id`,`message_id`,`session_id`,`project_id`,`workspace_id`,`time_created`,`visible`)
  SELECT 'request', NEW.`id`, NEW.`message_id`, NEW.`session_id`, s.`project_id`, s.`workspace_id`, NEW.`time_created`,
         CASE WHEN ifnull(json_extract(m.`data`, '$.detached'), 0) = 0 THEN 1 ELSE 0 END
  FROM `session` s
  LEFT JOIN `message` m ON m.`id` = NEW.`message_id`
  WHERE s.`id` = NEW.`session_id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_request_update`
AFTER UPDATE OF `session_id`, `message_id`, `time_created` ON `flight_request`
BEGIN
  DELETE FROM `flight_scope` WHERE `kind` = 'request' AND `id` = OLD.`id`;
  INSERT OR REPLACE INTO `flight_scope` (`kind`,`id`,`message_id`,`session_id`,`project_id`,`workspace_id`,`time_created`,`visible`)
  SELECT 'request', NEW.`id`, NEW.`message_id`, NEW.`session_id`, s.`project_id`, s.`workspace_id`, NEW.`time_created`,
         CASE WHEN ifnull(json_extract(m.`data`, '$.detached'), 0) = 0 THEN 1 ELSE 0 END
  FROM `session` s
  LEFT JOIN `message` m ON m.`id` = NEW.`message_id`
  WHERE s.`id` = NEW.`session_id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_request_delete`
AFTER DELETE ON `flight_request`
BEGIN
  DELETE FROM `flight_scope` WHERE `kind` = 'request' AND `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_part_insert`
AFTER INSERT ON `part`
WHEN json_extract(NEW.`data`, '$.type') = 'step-finish'
BEGIN
  INSERT OR REPLACE INTO `flight_scope` (`kind`,`id`,`message_id`,`session_id`,`project_id`,`workspace_id`,`time_created`,`visible`)
  SELECT 'step', NEW.`id`, NEW.`message_id`, NEW.`session_id`, s.`project_id`, s.`workspace_id`, NEW.`time_created`,
         CASE WHEN ifnull(json_extract(m.`data`, '$.detached'), 0) = 0 THEN 1 ELSE 0 END
  FROM `session` s
  LEFT JOIN `message` m ON m.`id` = NEW.`message_id`
  WHERE s.`id` = NEW.`session_id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_part_update`
AFTER UPDATE OF `data`, `session_id`, `message_id`, `time_created` ON `part`
WHEN json_extract(OLD.`data`, '$.type') = 'step-finish'
  OR json_extract(NEW.`data`, '$.type') = 'step-finish'
  OR NEW.`session_id` IS NOT OLD.`session_id`
  OR NEW.`message_id` IS NOT OLD.`message_id`
  OR NEW.`time_created` IS NOT OLD.`time_created`
BEGIN
  DELETE FROM `flight_scope` WHERE `kind` = 'step' AND `id` = OLD.`id`;
  INSERT OR REPLACE INTO `flight_scope` (`kind`,`id`,`message_id`,`session_id`,`project_id`,`workspace_id`,`time_created`,`visible`)
  SELECT 'step', NEW.`id`, NEW.`message_id`, NEW.`session_id`, s.`project_id`, s.`workspace_id`, NEW.`time_created`,
         CASE WHEN ifnull(json_extract(m.`data`, '$.detached'), 0) = 0 THEN 1 ELSE 0 END
  FROM `session` s
  LEFT JOIN `message` m ON m.`id` = NEW.`message_id`
  WHERE s.`id` = NEW.`session_id`
    AND json_extract(NEW.`data`, '$.type') = 'step-finish';
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_part_delete`
AFTER DELETE ON `part`
BEGIN
  DELETE FROM `flight_scope` WHERE `kind` = 'step' AND `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_session_scope`
AFTER UPDATE OF `project_id`, `workspace_id` ON `session`
BEGIN
  UPDATE `flight_scope`
  SET `project_id` = NEW.`project_id`, `workspace_id` = NEW.`workspace_id`
  WHERE `session_id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_session_delete`
AFTER DELETE ON `session`
BEGIN
  DELETE FROM `flight_scope` WHERE `session_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_message_delete`
AFTER DELETE ON `message`
BEGIN
  DELETE FROM `flight_scope` WHERE `message_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `flight_scope_message_visibility`
AFTER UPDATE OF `data` ON `message`
WHEN NEW.`data` IS NOT OLD.`data`
 AND ifnull(json_extract(OLD.`data`, '$.detached'), 0) != ifnull(json_extract(NEW.`data`, '$.detached'), 0)
BEGIN
  UPDATE `flight_scope`
  SET `visible` = CASE WHEN ifnull(json_extract(NEW.`data`, '$.detached'), 0) = 0 THEN 1 ELSE 0 END
  WHERE `message_id` = NEW.`id`;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `flight_scope` (`kind`,`id`,`message_id`,`session_id`,`project_id`,`workspace_id`,`time_created`,`visible`)
SELECT 'request', r.`id`, r.`message_id`, r.`session_id`, s.`project_id`, s.`workspace_id`, r.`time_created`,
       CASE WHEN ifnull(json_extract(m.`data`, '$.detached'), 0) = 0 THEN 1 ELSE 0 END
FROM `flight_request` r
JOIN `session` s ON s.`id` = r.`session_id`
LEFT JOIN `message` m ON m.`id` = r.`message_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `flight_scope` (`kind`,`id`,`message_id`,`session_id`,`project_id`,`workspace_id`,`time_created`,`visible`)
SELECT 'step', p.`id`, p.`message_id`, p.`session_id`, s.`project_id`, s.`workspace_id`, p.`time_created`,
       CASE WHEN ifnull(json_extract(m.`data`, '$.detached'), 0) = 0 THEN 1 ELSE 0 END
FROM `part` p
JOIN `session` s ON s.`id` = p.`session_id`
LEFT JOIN `message` m ON m.`id` = p.`message_id`
WHERE json_extract(p.`data`, '$.type') = 'step-finish';
