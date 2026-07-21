ALTER TABLE `studio_project`
  ADD COLUMN `visibility` VARCHAR(20) NOT NULL DEFAULT 'private' COMMENT '可见性：private/public/open' AFTER `preview_url`,
  ADD INDEX `idx_visibility` (`visibility`);
