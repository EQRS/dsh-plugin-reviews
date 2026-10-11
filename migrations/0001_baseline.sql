-- 0001_baseline.sql
-- DSH Plugin Review · 最小功能切片基线
--
-- 权威结构以本目录的 SQL 为准（见 README-切片说明.md §迁移策略）。
-- 约定（数据库模型第 1 节 / 架构第 55 节）：
--   ID  = 规范小写 UUIDv7 的 TEXT
--   T   = TEXT
--   N   = INTEGER
--   B   = INTEGER + CHECK IN (0,1)
--   TS  = UTC 毫秒 INTEGER
--   J   = 经注册结构校验的 JSON TEXT
--   E   = TEXT + 明确枚举 CHECK
--
-- 本切片共 18 张表，仅覆盖：登录 → 收录插件 → 写/审/发一篇评测 → 评论。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 3.1 身份
-- ============================================================

CREATE TABLE users (
  id                     TEXT    PRIMARY KEY,
  nickname               TEXT    NOT NULL CHECK (trim(nickname) <> ''),
  avatar_url             TEXT,
  role                   TEXT    NOT NULL CHECK (role IN ('user','admin')),
  account_status         TEXT    NOT NULL CHECK (account_status IN ('active','disabled')),
  management_version     INTEGER NOT NULL DEFAULT 0 CHECK (management_version >= 0),
  account_status_version INTEGER NOT NULL DEFAULT 0 CHECK (account_status_version >= 0),
  created_at             INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at             INTEGER NOT NULL CHECK (updated_at >= 0),
  last_login_at          INTEGER CHECK (last_login_at IS NULL OR last_login_at >= 0)
);

CREATE TABLE external_identities (
  id                TEXT    PRIMARY KEY,
  user_id           TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider          TEXT    NOT NULL CHECK (provider IN ('github')),
  provider_user_id  TEXT    NOT NULL CHECK (trim(provider_user_id) <> ''),
  provider_username TEXT    NOT NULL CHECK (trim(provider_username) <> ''),
  profile_url       TEXT    NOT NULL,
  avatar_url        TEXT,
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  synced_at         INTEGER NOT NULL CHECK (synced_at >= 0),
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);
CREATE INDEX idx_external_identities_user ON external_identities(user_id);

CREATE TABLE user_sessions (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  token_digest        TEXT    NOT NULL CHECK (length(token_digest) = 64),
  created_at          INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at          INTEGER NOT NULL CHECK (expires_at >= 0),
  absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at >= 0),
  last_seen_at        INTEGER NOT NULL CHECK (last_seen_at >= 0),
  last_renewed_at     INTEGER NOT NULL CHECK (last_renewed_at >= 0),
  revoked_at          INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  UNIQUE (token_digest),
  -- 架构第 105 节：created ≤ expires ≤ absolute
  CHECK (created_at <= expires_at AND expires_at <= absolute_expires_at)
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, revoked_at, expires_at);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

-- ============================================================
-- 3.2 目录：仓库与插件身份（架构第 30 节）
-- ============================================================

CREATE TABLE repositories (
  id                          TEXT    PRIMARY KEY,
  github_repository_id        TEXT    NOT NULL CHECK (trim(github_repository_id) <> ''),
  full_name                   TEXT    NOT NULL CHECK (trim(full_name) <> ''),
  html_url                    TEXT    NOT NULL,
  is_archived                 INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  availability_state          TEXT    NOT NULL DEFAULT 'unknown'
                                CHECK (availability_state IN ('unknown','available','unavailable')),
  last_checked_at             INTEGER CHECK (last_checked_at IS NULL OR last_checked_at >= 0),
  last_successful_check_at    INTEGER CHECK (last_successful_check_at IS NULL OR last_successful_check_at >= 0),
  created_at                  INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at                  INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (github_repository_id)
);
CREATE INDEX idx_repositories_availability ON repositories(availability_state, id);

CREATE TABLE plugins (
  id            TEXT    PRIMARY KEY,
  repository_id TEXT    NOT NULL REFERENCES repositories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 插件在仓库中的规范化子路径，根目录统一表示为 '.'；保留实际大小写。
  plugin_path   TEXT    NOT NULL CHECK (trim(plugin_path) <> ''),
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (repository_id, plugin_path COLLATE BINARY)
);
CREATE INDEX idx_plugins_updated ON plugins(updated_at, id);

-- ============================================================
-- 3.3 公共内容与评测
-- ============================================================

-- 公共内容基础实体（架构第 18、33 节）。
-- 与 reviews 互指：reviews.id = content_entities.id，采用延迟外键在 commit 时配对。
CREATE TABLE content_entities (
  id                          TEXT    PRIMARY KEY,
  content_type                TEXT    NOT NULL CHECK (content_type IN ('review','pack_release')),
  author_id                   TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 子类型回指：与具体子表互指，采用延迟外键，commit 时统一校验配对。
  -- 必须显式 DEFERRABLE INITIALLY DEFERRED：仅靠 PRAGMA defer_foreign_keys=ON 时
  -- 表定义里未标记 DEFERRABLE 的外键仍按即时方式检查（0002 触发器只是把错误信息说清楚）。
  review_id                   TEXT    REFERENCES reviews(id) DEFERRABLE INITIALLY DEFERRED,
  pack_release_id             TEXT,
  -- 内容对象建立时间（数据库模型第 4 节 content_entities.created_at）
  created_at                  INTEGER NOT NULL CHECK (created_at >= 0),
  first_published_at          INTEGER CHECK (first_published_at IS NULL OR first_published_at >= 0),
  public_updated_at           INTEGER CHECK (public_updated_at IS NULL OR public_updated_at >= 0),
  withdrawn_at                INTEGER CHECK (withdrawn_at IS NULL OR withdrawn_at >= 0),
  withdrawal_reason           TEXT,
  hidden_at                   INTEGER CHECK (hidden_at IS NULL OR hidden_at >= 0),
  hidden_by                   TEXT REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  hidden_reason               TEXT,
  visibility_control_version  INTEGER NOT NULL DEFAULT 0 CHECK (visibility_control_version >= 0),

  -- 子类型回指：按类型恰好一个，且必须等于自身 ID（同一事务配对，commit 时验证）
  CHECK (
    (content_type = 'review'      AND review_id = id         AND pack_release_id IS NULL)
    OR
    (content_type = 'pack_release' AND pack_release_id = id  AND review_id IS NULL)
  ),
  -- 切片闸门：本切片只实现 review 子类型，plugin_pack_releases 尚未建立。
  -- 若不在这里拦住，一条 pack_release 公共记录会没有任何具体子表承接，
  -- 变成"看起来存在、实际没有内容"的孤儿行。放开本约束时必须同时建立该子表。
  CHECK (content_type = 'review'),
  -- 撤回时间与原因成对
  CHECK ((withdrawn_at IS NULL) = (withdrawal_reason IS NULL)),
  -- 隐藏时间、操作者、原因须全空或全部填写
  CHECK (
    (hidden_at IS NULL AND hidden_by IS NULL AND hidden_reason IS NULL)
    OR
    (hidden_at IS NOT NULL AND hidden_by IS NOT NULL AND hidden_reason IS NOT NULL)
  ),
  -- 不在公共表另存“公开状态”字段；可见性由有效公开修订 + 控制字段计算。
  UNIQUE (id, content_type, author_id),
  UNIQUE (id, author_id)
);
CREATE INDEX idx_content_entities_author ON content_entities(author_id, created_at, id);
CREATE INDEX idx_content_entities_public ON content_entities(content_type, public_updated_at, id);

CREATE TABLE reviews (
  id                          TEXT    PRIMARY KEY
                                REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  plugin_id                   TEXT    REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_kind                 TEXT    NOT NULL DEFAULT 'community' CHECK (source_kind IN ('community','site')),
  published_revision_id       TEXT,
  latest_submitted_revision_id TEXT,
  CHECK (published_revision_id IS NULL OR plugin_id IS NOT NULL),
  CHECK (latest_submitted_revision_id IS NULL OR plugin_id IS NOT NULL)
);
CREATE INDEX idx_reviews_plugin ON reviews(plugin_id, id);
-- 联合唯一键，供 reviews → review_revisions 的联合外键引用
CREATE UNIQUE INDEX uq_reviews_id_plugin ON reviews(id, plugin_id);

-- 提交修订：不可变快照（架构第 34.2 节）
CREATE TABLE review_revisions (
  id              TEXT    PRIMARY KEY,
  review_id       TEXT    NOT NULL REFERENCES reviews(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  plugin_id       TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title           TEXT    NOT NULL CHECK (trim(title) <> ''),
  body_markdown   TEXT    NOT NULL,
  -- 版本结构 JSON：{"kind":"known","value":...} 或 {"kind":"unknown",...}
  plugin_version  TEXT    NOT NULL CHECK (json_valid(plugin_version)),
  dsh_version     TEXT    NOT NULL CHECK (json_valid(dsh_version)),
  submitted_at    INTEGER NOT NULL CHECK (submitted_at >= 0),
  UNIQUE (review_id, revision_number),
  UNIQUE (review_id, id),
  UNIQUE (review_id, plugin_id, id)
);
CREATE INDEX idx_review_revisions_plugin ON review_revisions(plugin_id, submitted_at, id);

-- 评测表：公开修订与最近提交修订（延迟外键指向 review_revisions）
-- 注意：SQLite 不允许 ALTER TABLE ADD CONSTRAINT，需要外键的表在 CREATE 时直接声明。
-- 因此 reviews 的两个修订指针外键通过触发器校验（见 0002_triggers.sql），
-- 并由服务层在发布/提交事务中保证；此处保留列与索引。

-- 编辑草稿：统一保存与重复请求回执（架构第 37 节）
CREATE TABLE content_drafts (
  id                    TEXT    PRIMARY KEY,
  owner_id              TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  draft_type            TEXT    NOT NULL CHECK (draft_type IN ('review','pack')),
  review_id             TEXT    REFERENCES reviews(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  base_review_revision_id TEXT  REFERENCES review_revisions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payload               TEXT    NOT NULL CHECK (json_valid(payload)),
  payload_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_schema_version >= 1),
  save_version          INTEGER NOT NULL DEFAULT 0 CHECK (save_version >= 0),
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  saved_at              INTEGER NOT NULL CHECK (saved_at >= 0),
  -- 按类型恰好一个根目标：本切片只实现 review 草稿
  CHECK (
    (draft_type = 'review' AND review_id IS NOT NULL)
    OR (draft_type = 'pack')
  )
);
-- 评测草稿对 review_id 唯一：一篇评测只有一份当前编辑草稿
CREATE UNIQUE INDEX uq_drafts_review ON content_drafts(review_id) WHERE draft_type = 'review';
CREATE INDEX idx_drafts_owner ON content_drafts(owner_id, saved_at DESC, id);

CREATE TABLE draft_save_receipts (
  draft_id       TEXT    NOT NULL REFERENCES content_drafts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  request_key    TEXT    NOT NULL CHECK (trim(request_key) <> ''),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  payload_digest TEXT    NOT NULL CHECK (length(payload_digest) = 64),
  result_version INTEGER NOT NULL CHECK (result_version >= 0),
  saved_at       INTEGER NOT NULL CHECK (saved_at >= 0),
  PRIMARY KEY (draft_id, request_key),
  -- result_version = expected_version + 1
  CHECK (result_version = expected_version + 1)
);

-- ============================================================
-- 3.4 审核处理记录
-- ============================================================
--
-- 注意声明顺序：`content_submissions` 同时引用 review_revisions（3.3）与
-- comment_revisions（3.5），而 SQLite 要求被引用的表先存在，因此提交表在 3.5 末尾创建。

CREATE TABLE content_moderation_records (
  id             TEXT    PRIMARY KEY,
  submission_id  TEXT    NOT NULL REFERENCES content_submissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation_key  TEXT    NOT NULL CHECK (trim(operation_key) <> ''),
  stage          TEXT    NOT NULL CHECK (stage IN ('rule_check','content_screen','manual_review','publish')),
  result         TEXT    NOT NULL CHECK (result IN ('pass','needs_changes','manual_review','fault','ineligible')),
  actor_kind     TEXT    NOT NULL CHECK (actor_kind IN ('user','admin','system')),
  actor_user_id  TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  task_id        TEXT,
  reason         TEXT    NOT NULL CHECK (trim(reason) <> ''),
  evidence       TEXT    NOT NULL CHECK (json_valid(evidence)),
  created_at     INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (submission_id, operation_key),
  -- 系统身份须有 task_id；人工身份须有 actor_user_id；不允许全空或错误组合
  CHECK (
    (actor_kind = 'system' AND task_id IS NOT NULL)
    OR (actor_kind IN ('user','admin') AND actor_user_id IS NOT NULL)
  )
);
CREATE INDEX idx_moderation_submission ON content_moderation_records(submission_id, created_at, id);

-- ============================================================
-- 3.5 评论
-- ============================================================

CREATE TABLE comments (
  id                            TEXT    PRIMARY KEY,
  content_entity_id             TEXT    NOT NULL REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_id                     TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reply_to_comment_id           TEXT,
  root_comment_id               TEXT,
  published_revision_id         TEXT,
  latest_submitted_revision_id  TEXT,
  created_at                    INTEGER NOT NULL CHECK (created_at >= 0),
  first_published_at            INTEGER CHECK (first_published_at IS NULL OR first_published_at >= 0),
  edited_at                     INTEGER CHECK (edited_at IS NULL OR edited_at >= 0),
  deleted_at                    INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  -- 顶层两个回复关联均空；回复两者均非空且不能指自己
  CHECK (
    (reply_to_comment_id IS NULL AND root_comment_id IS NULL)
    OR
    (reply_to_comment_id IS NOT NULL AND root_comment_id IS NOT NULL
      AND reply_to_comment_id <> id AND root_comment_id <> id)
  ),
  UNIQUE (content_entity_id, id),
  UNIQUE (content_entity_id, id, author_id),
  -- 回复的同目标归属：reply/root 必须指向同一公共内容下的评论。
  -- 用真正的联合外键表达（数据库模型第 4/5 节），而不是只靠触发器：
  -- 延迟语义让「回复先行、目标后建」的同一事务顺序也能成立。
  FOREIGN KEY (content_entity_id, reply_to_comment_id)
    REFERENCES comments(content_entity_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (content_entity_id, root_comment_id)
    REFERENCES comments(content_entity_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_comments_target ON comments(content_entity_id, root_comment_id, first_published_at, id);
CREATE INDEX idx_comments_author ON comments(author_id, created_at DESC, id);

CREATE TABLE comment_revisions (
  id              TEXT    PRIMARY KEY,
  comment_id      TEXT    NOT NULL REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  body            TEXT    NOT NULL CHECK (trim(body) <> ''),
  submitted_at    INTEGER NOT NULL CHECK (submitted_at >= 0),
  UNIQUE (comment_id, revision_number),
  UNIQUE (comment_id, id)
);

-- 盖楼归属（同目标、root 必为顶层）由本表的联合外键 + 0002_triggers.sql 的受限触发器共同校验。
-- comments 的修订指针归属由 0002 的触发器校验。

-- ------------------------------------------------------------
-- 提交记录（声明位置在评论之后：它引用 comment_revisions）
-- ------------------------------------------------------------
CREATE TABLE content_submissions (
  id                     TEXT    PRIMARY KEY,
  submitted_by           TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submission_type        TEXT    NOT NULL CHECK (submission_type IN ('review_revision','comment_revision')),
  review_revision_id     TEXT    REFERENCES review_revisions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 必须可延迟：comments / comment_revisions / content_submissions 在同一事务内建立，
  -- 插入顺序在业务上并不固定（数据库模型第 15 节「循环写入顺序」）。
  -- 这里不写 ON DELETE RESTRICT：历史快照已由 0002 的不可变触发器保护，
  -- 而即时 RESTRICT 会与延迟语义叠加，让「先把提交建好再落修订」的合法顺序失败。
  comment_revision_id    TEXT    REFERENCES comment_revisions(id) ON UPDATE RESTRICT
                           DEFERRABLE INITIALLY DEFERRED,
  draft_id               TEXT    REFERENCES content_drafts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  draft_save_version     INTEGER CHECK (draft_save_version IS NULL OR draft_save_version >= 0),
  request_key            TEXT    NOT NULL CHECK (trim(request_key) <> ''),
  request_digest         TEXT    NOT NULL CHECK (length(request_digest) = 64),
  processing_state       TEXT    NOT NULL
                           CHECK (processing_state IN ('pending','checking','needs_changes','manual_review','approved','published','ineligible')),
  state_version          INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  publication_context    TEXT    NOT NULL CHECK (json_valid(publication_context)),
  submitted_at           INTEGER NOT NULL CHECK (submitted_at >= 0),
  updated_at             INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (submitted_by, request_key),
  -- 按类型恰好一个快照目标
  CHECK (
    (submission_type = 'review_revision'
      AND review_revision_id IS NOT NULL AND comment_revision_id IS NULL
      AND draft_id IS NOT NULL AND draft_save_version IS NOT NULL)
    OR
    (submission_type = 'comment_revision'
      AND comment_revision_id IS NOT NULL AND review_revision_id IS NULL
      AND draft_id IS NULL AND draft_save_version IS NULL)
  )
);
-- 一份快照只有一条提交
CREATE UNIQUE INDEX uq_submissions_review_revision
  ON content_submissions(review_revision_id) WHERE review_revision_id IS NOT NULL;
CREATE UNIQUE INDEX uq_submissions_comment_revision
  ON content_submissions(comment_revision_id) WHERE comment_revision_id IS NOT NULL;
CREATE INDEX idx_submissions_state ON content_submissions(processing_state, submitted_at, id);
CREATE INDEX idx_submissions_author ON content_submissions(submitted_by, submitted_at DESC, id);

-- ============================================================
-- 3.6 任务队列
-- ============================================================

CREATE TABLE background_tasks (
  id                  TEXT    PRIMARY KEY,
  task_type           TEXT    NOT NULL
                        CHECK (task_type IN ('review_check','review_publish','comment_check','comment_publish')),
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
CREATE INDEX idx_tasks_claimable ON background_tasks(processing_state, available_at, scheduling_group, id);
CREATE INDEX idx_tasks_lease ON background_tasks(processing_state, lease_expires_at, id);

CREATE TABLE background_task_attempts (
  id              TEXT    PRIMARY KEY,
  task_id         TEXT    NOT NULL REFERENCES background_tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  attempt_number  INTEGER NOT NULL CHECK (attempt_number > 0),
  retry_cycle     INTEGER NOT NULL CHECK (retry_cycle >= 1),
  execution_token TEXT    NOT NULL CHECK (trim(execution_token) <> ''),
  worker_reference TEXT   NOT NULL CHECK (trim(worker_reference) <> ''),
  config_snapshot TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(config_snapshot)),
  started_at      INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at     INTEGER CHECK (finished_at IS NULL OR finished_at >= 0),
  deadline_at     INTEGER CHECK (deadline_at IS NULL OR deadline_at >= 0),
  last_progress_at INTEGER NOT NULL CHECK (last_progress_at >= 0),
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('success','error','lease_expired','skipped')),
  error_code      TEXT,
  UNIQUE (task_id, attempt_number),
  UNIQUE (execution_token),
  -- 进行中 outcome/finished_at 都为空；结束时两者同时存在
  CHECK ((outcome IS NULL) = (finished_at IS NULL))
);
CREATE INDEX idx_attempts_task ON background_task_attempts(task_id, retry_cycle, attempt_number);

-- ============================================================
-- 3.7 审计与配置
-- ============================================================

CREATE TABLE operation_records (
  id                TEXT    PRIMARY KEY,
  action_type       TEXT    NOT NULL CHECK (trim(action_type) <> ''),
  operation_key     TEXT    NOT NULL CHECK (trim(operation_key) <> ''),
  actor_kind        TEXT    NOT NULL CHECK (actor_kind IN ('user','admin','system')),
  actor_user_id     TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 历史定位：不是业务关系外键，刻意保留（数据库模型第 10 节）
  target_type       TEXT    NOT NULL CHECK (trim(target_type) <> ''),
  target_id         TEXT    NOT NULL CHECK (trim(target_id) <> ''),
  target_snapshot   TEXT    NOT NULL CHECK (json_valid(target_snapshot)),
  changes           TEXT    NOT NULL CHECK (json_valid(changes)),
  reason            TEXT    NOT NULL CHECK (trim(reason) <> ''),
  request_reference TEXT,
  task_id           TEXT    REFERENCES background_tasks(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (action_type, operation_key),
  CHECK (
    (actor_kind = 'system' AND actor_user_id IS NULL)
    OR (actor_kind IN ('user','admin') AND actor_user_id IS NOT NULL)
  )
);
CREATE INDEX idx_operation_target ON operation_records(target_type, target_id, created_at, id);
CREATE INDEX idx_operation_actor ON operation_records(actor_user_id, created_at, id);

CREATE TABLE configuration_revisions (
  id                 TEXT    PRIMARY KEY,
  revision_number    INTEGER NOT NULL CHECK (revision_number > 0),
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  effective_snapshot TEXT    NOT NULL CHECK (json_valid(effective_snapshot)),
  changes            TEXT    NOT NULL CHECK (json_valid(changes)),
  reason             TEXT    NOT NULL CHECK (trim(reason) <> ''),
  changed_by         TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at         INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (revision_number)
);

CREATE TABLE site_settings (
  key                    TEXT    PRIMARY KEY CHECK (trim(key) <> ''),
  value                  TEXT    NOT NULL CHECK (json_valid(value)),
  changed_in_revision_id TEXT    NOT NULL REFERENCES configuration_revisions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by             TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at             INTEGER NOT NULL CHECK (updated_at >= 0)
);
