-- 0033_featured_columns.sql
--
-- 精选专栏（设计见 docs/项目规划/设计-精选专栏.md）。
--
-- 一句话：以「期」为单位的站方编辑专栏——一期一个主题 + 前言 + 一组插件，
-- 每个插件带简述、推荐理由、百分制评分与可选的外部链接。
--
-- 三条不变量：
--   1. **期号是身份**：URL 用 /featured/{issue_number}，标题改了链接不断；
--   2. **顺序与内容绑定**：position 属于条目行，换位时整份清单重写（不按位置存文案）；
--   3. **不建 UNIQUE(column_id, position)**：SQLite 无延迟约束，重排中间态必然撞键，
--      顺序由应用层规范化为 0..n-1 保证。
--
-- 评分口径（2026-11-01 定案）：编辑按「插件功能性」打 0–100 整数，必填、不由站内数据聚合。
-- 官方测试集：每期手填一条链接，只接受 https；站内/站外由**渲染层**按域名判断（库里不固化域名）。

CREATE TABLE featured_columns (
  id            TEXT    PRIMARY KEY,
  issue_number  INTEGER NOT NULL CHECK (issue_number > 0),
  title         TEXT    NOT NULL CHECK (trim(title) <> '' AND length(title) <= 80),
  theme         TEXT    NOT NULL CHECK (trim(theme) <> '' AND length(theme) <= 200),
  -- 草稿期允许为空；发布时由服务层校验非空（内容规则留在应用层，便于给出字段级提示）
  preface_md    TEXT    NOT NULL DEFAULT '' CHECK (length(preface_md) <= 20000),
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at  INTEGER CHECK (published_at IS NULL OR published_at >= 0),
  created_by    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 新建去重：同一管理员重复点「创建」不会多出一期
  request_key   TEXT    NOT NULL CHECK (trim(request_key) <> ''),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (issue_number),
  UNIQUE (created_by, request_key),
  -- 发布 ⇔ 有发布时间
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);
CREATE INDEX idx_featured_published ON featured_columns(status, published_at DESC, id);

CREATE TABLE featured_column_items (
  id                  TEXT    PRIMARY KEY,
  column_id           TEXT    NOT NULL REFERENCES featured_columns(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  plugin_id           TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position            INTEGER NOT NULL CHECK (position >= 0),
  summary             TEXT    NOT NULL CHECK (trim(summary) <> '' AND length(summary) <= 200),
  reason              TEXT    NOT NULL CHECK (trim(reason) <> '' AND length(reason) <= 1000),
  -- 百分制编辑评分
  score               INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  -- 官方测试集链接（可空）：只收 https，长度上限 2000
  detail_url          TEXT    CHECK (detail_url IS NULL OR (length(detail_url) <= 2000 AND detail_url LIKE 'https://%')),
  recommended_version TEXT,
  created_at          INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
  -- 同一期不重复推荐同一插件
  UNIQUE (column_id, plugin_id),
  UNIQUE (column_id, id)
);
CREATE INDEX idx_featured_items_column ON featured_column_items(column_id, position, id);
CREATE INDEX idx_featured_items_plugin ON featured_column_items(plugin_id);
