-- dsh:migration-transaction=off
--
-- 0021_content_entities_pack_release.sql
--
-- 放开 `content_entities` 的切片闸门：允许 `content_type = 'pack_release'`。
--
-- 背景：基线（0001）里这条闸门是**有意**留的 —— 当时 `plugin_pack_releases` 还不存在，
-- 放开会造出「公共记录在、却没有具体内容承接」的孤儿行。迁移 0020 建好了
-- `plugin_pack_releases`，现在同时做两件事：
--   1. 去掉 `CHECK (content_type = 'review')`；
--   2. 把 `pack_release_id` 从裸列升级为**指向 `plugin_pack_releases(id)` 的延迟外键**，
--      让「公共内容 ↔ 整合包版本」的一对一配对在数据库层面成立（架构 §33/§35.2）。
--
-- SQLite 不能 ALTER CHECK，只能重建表；重建期间必须关外键（PRAGMA foreign_keys 在事务内是
-- no-op，所以本文件用 `-- dsh:migration-transaction=off`，迁移器不会替我们包事务）。
-- 表名保持不变，其它表上指向 content_entities 的外键（comments/notifications/reports/reviews）
-- 在改名后自动指回同名表，无需改它们。

PRAGMA foreign_keys = OFF;

BEGIN;

-- `trg_submissions_snapshot_owner_insert` 属于 content_submissions，但触发器体内
-- JOIN content_entities；重建期间 content_entities 会短暂消失，而 SQLite 在
-- `ALTER TABLE ... RENAME` 时要重新解析所有触发器 → 会报「no such table」。
-- 因此先删掉它，重建完成后再逐字还原（语义与 0002 完全一致）。
DROP TRIGGER IF EXISTS trg_submissions_snapshot_owner_insert;

CREATE TABLE content_entities_new (
  id                          TEXT    PRIMARY KEY,
  content_type                TEXT    NOT NULL CHECK (content_type IN ('review','pack_release')),
  author_id                   TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_id                   TEXT    REFERENCES reviews(id) DEFERRABLE INITIALLY DEFERRED,
  pack_release_id             TEXT    REFERENCES plugin_pack_releases(id)
                                DEFERRABLE INITIALLY DEFERRED,
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
  -- 撤回时间与原因成对
  CHECK ((withdrawn_at IS NULL) = (withdrawal_reason IS NULL)),
  -- 隐藏时间、操作者、原因须全空或全部填写
  CHECK (
    (hidden_at IS NULL AND hidden_by IS NULL AND hidden_reason IS NULL)
    OR
    (hidden_at IS NOT NULL AND hidden_by IS NOT NULL AND hidden_reason IS NOT NULL)
  ),
  UNIQUE (id, content_type, author_id),
  UNIQUE (id, author_id)
);

INSERT INTO content_entities_new
  (id, content_type, author_id, review_id, pack_release_id, created_at,
   first_published_at, public_updated_at, withdrawn_at, withdrawal_reason,
   hidden_at, hidden_by, hidden_reason, visibility_control_version)
SELECT
  id, content_type, author_id, review_id, pack_release_id, created_at,
  first_published_at, public_updated_at, withdrawn_at, withdrawal_reason,
  hidden_at, hidden_by, hidden_reason, visibility_control_version
FROM content_entities;

DROP TABLE content_entities;

ALTER TABLE content_entities_new RENAME TO content_entities;

CREATE INDEX idx_content_entities_author ON content_entities(author_id, created_at, id);
CREATE INDEX idx_content_entities_public ON content_entities(content_type, public_updated_at, id);

-- ---- 重建触发器（DROP TABLE 会一并删掉它们；0002 的语义逐字保留）----

CREATE TRIGGER trg_content_entities_review_backref_insert
BEFORE INSERT ON content_entities
WHEN NEW.content_type = 'review'
BEGIN
  SELECT RAISE(ABORT, 'content_entities: review 类型必须带 review_id = id')
  WHERE NEW.review_id IS NOT NEW.id;
END;

CREATE TRIGGER trg_content_entities_review_backref_update
BEFORE UPDATE ON content_entities
WHEN NEW.content_type = 'review'
BEGIN
  SELECT RAISE(ABORT, 'content_entities: review 类型必须带 review_id = id')
  WHERE NEW.review_id IS NOT NEW.id;
END;

-- 整合包版本的配对校验（0021 新增）：pack_release 的 pack_release_id 必须等于自身 ID
CREATE TRIGGER trg_content_entities_pack_backref_insert
BEFORE INSERT ON content_entities
WHEN NEW.content_type = 'pack_release'
BEGIN
  SELECT RAISE(ABORT, 'content_entities: pack_release 类型必须带 pack_release_id = id')
  WHERE NEW.pack_release_id IS NOT NEW.id;
END;

CREATE TRIGGER trg_content_entities_pack_backref_update
BEFORE UPDATE ON content_entities
WHEN NEW.content_type = 'pack_release'
BEGIN
  SELECT RAISE(ABORT, 'content_entities: pack_release 类型必须带 pack_release_id = id')
  WHERE NEW.pack_release_id IS NOT NEW.id;
END;

CREATE TRIGGER trg_content_entities_no_type_switch
BEFORE UPDATE OF content_type ON content_entities
BEGIN
  SELECT RAISE(ABORT, 'content_entities: 公共内容类型不可变更')
  WHERE NEW.content_type <> OLD.content_type;
END;

CREATE TRIGGER trg_content_entities_visibility_version
BEFORE UPDATE OF withdrawn_at, hidden_at ON content_entities
BEGIN
  SELECT RAISE(ABORT, 'content_entities: 可见性控制变化必须递增 visibility_control_version')
  WHERE NEW.visibility_control_version <= OLD.visibility_control_version;
END;

-- ---- 还原因重建而临时删除的触发器（0002 §5，逐字保留）----

CREATE TRIGGER trg_submissions_snapshot_owner_insert
BEFORE INSERT ON content_submissions
BEGIN
  -- 评测提交：快照必须存在，且作者与提交者一致
  SELECT RAISE(ABORT, 'content_submissions: 评测修订快照不存在')
  WHERE NEW.submission_type = 'review_revision'
    AND NOT EXISTS (SELECT 1 FROM review_revisions r WHERE r.id = NEW.review_revision_id);
  SELECT RAISE(ABORT, 'content_submissions: 提交者与评测作者不一致')
  WHERE NEW.submission_type = 'review_revision'
    AND NOT EXISTS (
      SELECT 1 FROM review_revisions r
      JOIN reviews rv ON rv.id = r.review_id
      JOIN content_entities ce ON ce.id = rv.id
      WHERE r.id = NEW.review_revision_id AND ce.author_id = NEW.submitted_by
    );
  -- 评论提交：快照必须存在，且作者与提交者一致
  SELECT RAISE(ABORT, 'content_submissions: 评论修订快照不存在')
  WHERE NEW.submission_type = 'comment_revision'
    AND NOT EXISTS (SELECT 1 FROM comment_revisions r WHERE r.id = NEW.comment_revision_id);
  SELECT RAISE(ABORT, 'content_submissions: 提交者与评论作者不一致')
  WHERE NEW.submission_type = 'comment_revision'
    AND NOT EXISTS (
      SELECT 1 FROM comment_revisions r
      JOIN comments c ON c.id = r.comment_id
      WHERE r.id = NEW.comment_revision_id AND c.author_id = NEW.submitted_by
    );
END;

COMMIT;

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
