-- dsh:migration-transaction=off
--
-- 0016_notification_nullable_content.sql
--
-- 让「处理结果」通知可以**不挂在某篇内容上**。
--
-- 起因：资料纠错（迁移 0015）处理完要给提交者发结果，但插件本身不是 `content_entities`
-- 的一行（只有评测/整合包版本才是）。0013 里 `content_entity_id` 是 NOT NULL，
-- 于是"给纠错提交者发通知"要么编一个假引用，要么发不出去 —— 两个都不能接受。
--
-- 规则（写进 CHECK）：
--   * 评论类通知（comment_on_content / reply_to_comment）**必须**有 content_entity_id；
--   * moderation_result 允许为空（举报处理仍然带着它指向的内容，纠错处理则不带）。
--
-- 与 0013 同样的重建方式：FK OFF → BEGIN → 建新 → 拷 → 删旧 → 改名 → 建索引 → COMMIT → FK ON。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE notifications_new (
  id                TEXT    PRIMARY KEY,
  recipient_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('comment_on_content', 'reply_to_comment', 'moderation_result')),
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_entity_id TEXT    REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deduplication_key TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  detail            TEXT,
  read_at           INTEGER CHECK (read_at IS NULL OR read_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (recipient_id <> actor_id),
  -- 评论类 ⇔ 有 comment_id
  CHECK ((kind IN ('comment_on_content', 'reply_to_comment')) = (comment_id IS NOT NULL)),
  -- 处理结果 ⇔ 有 detail
  CHECK ((kind = 'moderation_result') = (detail IS NOT NULL)),
  -- 只有"处理结果"允许没有内容锚点；评论类必须有（迁移 0016 的核心）
  CHECK (kind = 'moderation_result' OR content_entity_id IS NOT NULL),
  UNIQUE (deduplication_key)
);

INSERT INTO notifications_new
  (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, read_at, created_at)
SELECT
  id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, read_at, created_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_inbox ON notifications(recipient_id, read_at, created_at DESC, id);

COMMIT;

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
