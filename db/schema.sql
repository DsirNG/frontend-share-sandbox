-- ============================================
-- 工作室项目表
-- ============================================
CREATE TABLE IF NOT EXISTS `studio_project` (
    `id`            VARCHAR(20)     NOT NULL                    COMMENT '项目ID，如 p6fghnvnrk3',
    `user_id`       BIGINT          NOT NULL                    COMMENT '所属用户ID，关联 sys_user.id',
    `name`          VARCHAR(255)    NOT NULL DEFAULT ''         COMMENT '项目名称（zip文件名或package.json中的name）',
    `status`        VARCHAR(20)     NOT NULL DEFAULT 'queued'   COMMENT '构建状态：queued/extracting/installing/building/publishing/ready/failed',
    `framework`     VARCHAR(50)     NOT NULL DEFAULT 'unknown'  COMMENT '检测到的框架：React/Vue/Next.js/Vite/JavaScript/static等',
    `preview_url`   VARCHAR(500)    DEFAULT NULL                COMMENT '预览地址，构建完成后生成',
    `scripts`       JSON            DEFAULT NULL                COMMENT 'package.json 中的 scripts 字段',
    `dependencies`  JSON            DEFAULT NULL                COMMENT '合并后的 dependencies + devDependencies',
    `root_files`    JSON            DEFAULT NULL                COMMENT '项目根目录文件/文件夹列表',
    `logs`          JSON            DEFAULT NULL                COMMENT '构建日志，数组格式，最多保留600条',
    `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP  COMMENT '创建时间',
    `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (`id`),
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_status` (`status`),
    INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工作室项目表';
