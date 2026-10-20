-- 0015_plugin_corrections.sql
--
-- 资料纠错（`idea.md §2`、§23）：用户指出插件资料错误 → 管理员修正 → 修正值优先于同步值。
--
-- 为什么分成三张表而不是在 plugins 上加几列：
--   * `plugin_correction_requests` 是**用户提交的事项**（可多条、可被驳回）；
--   * `plugin_correction_handling_records` 是**处理记录**（§23：已处理事项进历史，方便追查）；
--   * `plugin_field_overrides` 是**当前生效的管理员修正**（一个字段最多一条，删除即"恢复同步值"）。
--   合成一张表会丢掉"谁在什么时候以什么理由改的"这条线索。
--
-- 关键设计：**同步值与管理员的修正值分开存**。
--   * `plugins.display_name / plugins.description` 永远是**同步来的原值**（GitHub 下次刷新照样写这里）；
--   * 修正在 `plugin_field_overrides` 里，读取时优先用修正值；
--   * 于是"恢复同步资料"只是删掉 override 一行，不需要重新探测 GitHub。
--
-- 字段白名单刻意只有两项：`display_name`（展示名）与 `description`（简介）。
-- 分类（topics）是**仓库级**的，修正它会影响同仓库的所有插件，语义与单插件纠错不同，
-- 留给后续单独设计（避免在这里留下"看起来能改、其实会波及别人"的坑）。

CREATE TABLE plugin_correction_requests (
  id            TEXT    PRIMARY KEY,
  plugin_id     TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submitted_by  TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 用户建议的修正值（JSON：{ "display_name": "...", "description": "..." }），只允许白名单字段
  proposed      TEXT    NOT NULL CHECK (json_valid(proposed)),
  description   TEXT    NOT NULL CHECK (trim(description) <> '' AND length(description) <= 2000),
  reference_url TEXT    CHECK (reference_url IS NULL OR length(reference_url) <= 500),
  state         TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'rejected')),
  created_at    INTEGER NOT NULL CHECK (created_at >= 0)
);

-- 后台待办：未处理优先、先进先出
CREATE INDEX idx_corrections_queue ON plugin_correction_requests(state, created_at ASC, id);

CREATE TABLE plugin_correction_handling_records (
  id                    TEXT    PRIMARY KEY,
  correction_request_id TEXT    NOT NULL REFERENCES plugin_correction_requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  plugin_id             TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  handled_by            TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action                TEXT    NOT NULL CHECK (action IN ('accept', 'reject')),
  -- §23：处理必须记录原因；空原因等于没记录
  reason                TEXT    NOT NULL CHECK (trim(reason) <> ''),
  created_at            INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX idx_correction_handling_by_request
  ON plugin_correction_handling_records(correction_request_id, created_at DESC, id);

CREATE TABLE plugin_field_overrides (
  id         TEXT    PRIMARY KEY,
  plugin_id  TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  field_key  TEXT    NOT NULL CHECK (field_key IN ('display_name', 'description')),
  -- 修正后的值（纯文本；展示名 ≤200、简介 ≤2000，应用层已校验）
  value      TEXT    NOT NULL CHECK (length(value) BETWEEN 1 AND 2000),
  updated_by TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason     TEXT    NOT NULL CHECK (trim(reason) <> ''),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  -- 一个插件的同一个字段，只允许一条生效修正
  UNIQUE (plugin_id, field_key)
);
