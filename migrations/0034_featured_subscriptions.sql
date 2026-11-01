-- dsh:migration-transaction=off
-- 0034_featured_subscriptions.sql
--
-- 精选订阅（订阅的是**栏目**，不是某一期）+ 新通知类型 featured_published。
--
-- 两件事：
--   1. 订阅表：每人一行，订阅「精选」这个栏目；之后每发布一期都给订阅者投一条通知。
--      （设计 §8.3：订阅栏目 = 新期都通知，不提供「只订某一期」。）
--   2. notifications 扩展：kind 增加 featured_published；同时补一个通用 link_url ——
--      精选是栏目而不是 content_entities 行，无法靠 content_entity_id 推导跳转地址。
--
-- 为什么重建 notifications：SQLite 改不了 CHECK，只能建新表 → 拷 → 删 → 改名。
-- 迁移 0016 已有一次同样处理，这里沿用同一手法（PRAGMA foreign_keys 关闭 + 事务内完成）。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE featured_subscriptions (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE notifications_new (
  id                TEXT    PRIMARY KEY,
  recipient_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('comment_on_content', 'reply_to_comment', 'moderation_result', 'featured_published')),
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_entity_id TEXT    REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deduplication_key TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  detail            TEXT,
  -- 站内跳转地址（精选等"栏目类"通知没有 content_entity_id，靠它指路）
  link_url          TEXT,
  read_at           INTEGER CHECK (read_at IS NULL OR read_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (recipient_id <> actor_id),
  -- 评论类 ⇔ 有 comment_id
  CHECK ((kind IN ('comment_on_content', 'reply_to_comment')) = (comment_id IS NOT NULL)),
  -- 处理结果 / 精选发布 ⇔ 有 detail
  CHECK ((kind IN ('moderation_result', 'featured_published')) = (detail IS NOT NULL)),
  -- 只有"处理结果"与"精选发布"允许没有内容锚点
  CHECK (kind IN ('moderation_result', 'featured_published') OR content_entity_id IS NOT NULL),
  UNIQUE (deduplication_key)
);

INSERT INTO notifications_new
  (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, link_url, read_at, created_at)
SELECT
  id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, NULL, read_at, created_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_inbox ON notifications(recipient_id, read_at, created_at DESC, id);

COMMIT;

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
