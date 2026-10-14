-- dsh:migration-transaction=off
-- 0007_task_type_plugin_discovery.sql
--
-- 目的：给 `background_tasks.task_type` 的 CHECK 增加 `plugin_discovery`
-- （插件目录的**自动发现**任务；见 `src/server/modules/catalog/discovery.ts`）。
--
-- 为什么必须重建表：SQLite **改不了列上的 CHECK 约束**（没有 ALTER TABLE ... ALTER CHECK），
-- 只能"新建 → 拷数据 → 删旧 → 改名"。而被外键引用（`background_task_attempts.task_id`、
-- `operation_records.task_id`）的表要重建，必须先把 `foreign_keys` 关掉；
-- 偏偏 `PRAGMA foreign_keys` **在事务里是空操作** —— 这就是文件头声明
-- `dsh:migration-transaction=off` 的原因（执行器不再替我们包事务，本文件自己管）。
--
-- ⚠️ 因此本文件必须自己保证原子性：PRAGMA 在 BEGIN 之前/之后，DDL 全在 BEGIN..COMMIT 之内。
-- 万一中途失败，会留下半成品（执行器的其它迁移有自动回滚，这条没有）——这是重建表的固有代价。
--
-- 拷贝列时**逐一列出**（不用 `SELECT *`）：列顺序在重建后必须与旧表一致，
-- 写全列名才能在 diff 里一眼看出"有没有漏列"。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE background_tasks_new (
  id                  TEXT    PRIMARY KEY,
  task_type           TEXT    NOT NULL
                        CHECK (task_type IN ('review_check','review_publish','comment_check','comment_publish','plugin_discovery')),
  deduplication_key   TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  requested_by        TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payload             TEXT    NOT NULL CHECK (json_valid(payload)),
  payload_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_schema_version >= 1),
  scheduling_group    TEXT    NOT NULL CHECK (trim(scheduling_group) <> ''),
  processing_state    TEXT    NOT NULL
                        CHECK (processing_state IN ('queued','running','retry_wait','succeeded','failed','skipped')),
  available_at        INTEGER NOT NULL CHECK (available_at >= 0),
  progress            TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(progress)),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_cycle         INTEGER NOT NULL DEFAULT 1 CHECK (retry_cycle >= 1),
  cycle_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (cycle_attempt_count >= 0),
  lease_owner         TEXT,
  lease_expires_at    INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  execution_token     TEXT,
  last_error_code     TEXT,
  last_error_summary  TEXT,
  created_at          INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
  finished_at         INTEGER CHECK (finished_at IS NULL OR finished_at >= 0),
  UNIQUE (task_type, deduplication_key),
  -- running 时三个执行权字段全非空；其他阶段全空
  CHECK (
    (processing_state = 'running'
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND execution_token IS NOT NULL)
    OR
    (processing_state <> 'running'
      AND lease_owner IS NULL AND lease_expires_at IS NULL AND execution_token IS NULL)
  ),
  -- 尝试计数关系与终态时间
  CHECK (cycle_attempt_count <= attempt_count),
  CHECK (processing_state NOT IN ('succeeded','failed','skipped') OR finished_at IS NOT NULL),
  UNIQUE (execution_token)
);

INSERT INTO background_tasks_new (
  id, task_type, deduplication_key, requested_by, payload, payload_schema_version,
  scheduling_group, processing_state, available_at, progress, attempt_count, retry_cycle,
  cycle_attempt_count, lease_owner, lease_expires_at, execution_token,
  last_error_code, last_error_summary, created_at, updated_at, finished_at
)
SELECT
  id, task_type, deduplication_key, requested_by, payload, payload_schema_version,
  scheduling_group, processing_state, available_at, progress, attempt_count, retry_cycle,
  cycle_attempt_count, lease_owner, lease_expires_at, execution_token,
  last_error_code, last_error_summary, created_at, updated_at, finished_at
FROM background_tasks;

DROP TABLE background_tasks;

ALTER TABLE background_tasks_new RENAME TO background_tasks;

-- 索引随旧表一起被删了，必须重建（名字与 0001 保持一致）。
CREATE INDEX idx_tasks_claimable ON background_tasks(processing_state, available_at, scheduling_group, id);
CREATE INDEX idx_tasks_lease ON background_tasks(processing_state, lease_expires_at, id);

COMMIT;

PRAGMA foreign_keys = ON;
