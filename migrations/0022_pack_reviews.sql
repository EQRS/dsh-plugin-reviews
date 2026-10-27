-- 0022_pack_reviews.sql
--
-- 整合包测评：与插件测评分开存表；测评对象是**整合包版本**（plugin_pack_releases），
-- 与 C 路线「版本 = 公共内容对象」一致（评论/举报绑定版本）。
--
-- 结构：
--   * pack_reviews.id 同时是 content_entities.id 与 reviews.id（review 类型锚点）；
--   * 测评内容在 pack_review_revisions，公开指针在 pack_reviews；
--   * 当前直接发布；后续接审核时把创建改为 pending、通过再设指针。

CREATE TABLE pack_reviews (
  id                          TEXT    PRIMARY KEY
                                REFERENCES reviews(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  release_id                  TEXT    NOT NULL
                                REFERENCES plugin_pack_releases(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  published_revision_id       TEXT,
  latest_submitted_revision_id TEXT,
  created_at                  INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX idx_pack_reviews_release ON pack_reviews(release_id, created_at DESC, id);
CREATE INDEX idx_pack_reviews_public ON pack_reviews(published_revision_id, created_at DESC, id);

CREATE TABLE pack_review_revisions (
  id               TEXT    PRIMARY KEY,
  review_id        TEXT    NOT NULL REFERENCES pack_reviews(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revision_number  INTEGER NOT NULL CHECK (revision_number > 0),
  release_id       TEXT    NOT NULL
                     REFERENCES plugin_pack_releases(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title            TEXT    NOT NULL CHECK (trim(title) <> ''),
  body_markdown    TEXT    NOT NULL,
  dsh_version      TEXT    NOT NULL CHECK (json_valid(dsh_version)),
  verdict          TEXT,
  evidence_refs    TEXT,
  assessment_level TEXT,
  submitted_at     INTEGER NOT NULL CHECK (submitted_at >= 0),
  UNIQUE (review_id, revision_number),
  UNIQUE (review_id, id)
);

CREATE INDEX idx_pack_review_revisions_release
  ON pack_review_revisions(release_id, submitted_at DESC, id);
