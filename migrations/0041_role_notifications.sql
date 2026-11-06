-- dsh:migration-transaction=off
-- 0041_role_notifications.sql
--
-- 用户身份体系（设计 docs/项目规划/设计-用户身份体系.md §7 / §9）：新增两种通知
--   * role_application_result —— 身份申请（普通用户 → 创作者 / 维护者）的审核结果；
--   * plugin_claim_result      —— 插件认领（把已收录插件认领到自己名下）的审核结果。
--
-- 为什么重建 notifications：SQLite 改不了 CHECK，只能建新表 → 拷 → 删 → 改名。
-- 沿用 0034 / 0036 的同一手法（PRAGMA foreign_keys 关闭 + 事务内完成）。
--
-- ⚠️ kind 并集按**本分支实查**取（migrations/0036_feedback_tickets.sql 第 87-104 行是
--    本分支上最后一个重建 notifications 的迁移）：漏掉任何一个已有 kind，重建后那些
--    历史行在拷贝阶段就会被新表的 CHECK 拒掉，等于静默丢数据。
--    本分支已有 5 项：comment_on_content / reply_to_comment / moderation_result /
--    featured_published / feedback_result；本次新增 2 项 → 共 7 项。
--
-- 两种新 kind 都是「栏目类通知」：不是 content_entities 的某一行，没有 content_entity_id，
-- 跳转地址存 link_url（身份申请结果 → /me/settings；认领结果 → /me/my-plugins），
-- 所以它们同时属于「必须有 detail」与「允许没有内容锚点」两组。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE notifications_new (
  id                TEXT    PRIMARY KEY,
  recipient_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('comment_on_content', 'reply_to_comment', 'moderation_result', 'featured_published', 'feedback_result', 'role_application_result', 'plugin_claim_result')),
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_entity_id TEXT    REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deduplication_key TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  detail            TEXT,
  -- 站内跳转地址（精选 / 反馈 / 身份申请 / 插件认领等"栏目类"通知没有 content_entity_id，靠它指路）
  link_url          TEXT,
  read_at           INTEGER CHECK (read_at IS NULL OR read_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (recipient_id <> actor_id),
  -- 评论类 ⇔ 有 comment_id
  CHECK ((kind IN ('comment_on_content', 'reply_to_comment')) = (comment_id IS NOT NULL)),
  -- 处理结果 / 精选发布 / 反馈处理结果 / 身份申请结果 / 认领结果 ⇔ 有 detail
  CHECK ((kind IN ('moderation_result', 'featured_published', 'feedback_result', 'role_application_result', 'plugin_claim_result')) = (detail IS NOT NULL)),
  -- 只有"栏目类"通知允许没有内容锚点
  CHECK (kind IN ('moderation_result', 'featured_published', 'feedback_result', 'role_application_result', 'plugin_claim_result') OR content_entity_id IS NOT NULL),
  UNIQUE (deduplication_key)
);

INSERT INTO notifications_new
  (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, link_url, read_at, created_at)
SELECT
  id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, link_url, read_at, created_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_inbox ON notifications(recipient_id, read_at, created_at DESC, id);

COMMIT;

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
