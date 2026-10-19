-- dsh:migration-transaction=off
--
-- 0013_notification_moderation_result.sql
--
-- 让站内通知能承载「处理结果」这一类（`idea.md §23`：举报/纠错的处理结果反馈给用户）。
--
-- 为什么要重建表：`notifications.kind` 的 CHECK 只允许两种评论通知，且 `comment_id NOT NULL`。
-- 处理结果通知没有评论、需要一段说明文字，两个约束都要改 —— SQLite 改不了 CHECK，只能
-- 「建新表 → 拷数据 → 删旧 → 改名」。
--
-- ⚠️ 重建一张**被外键约束指向别人**的表必须临时关掉 foreign_keys，而
-- `PRAGMA foreign_keys` 在事务里是空操作，所以本文件声明 `dsh:migration-transaction=off`
-- 自己管事务（迁移器见 src/server/platform/migrate.ts 的 NO_TRANSACTION_MARKER）。
-- 顺序：FK OFF → BEGIN → 建新表 → 拷 → 删旧 → 改名 → 建索引 → 提交 → FK ON。
--
-- 兼容性：历史通知（评论/回复）原样保留；新增两列 `detail`（处理结果说明）与可空的 `comment_id`。
-- 两条 CHECK 把"哪种通知该带什么"钉死：
--   * 评论类通知必须带 comment_id；
--   * 处理结果通知必须带 detail。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE notifications_new (
  id                TEXT    PRIMARY KEY,
  recipient_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('comment_on_content', 'reply_to_comment', 'moderation_result')),
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_entity_id TEXT    NOT NULL REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deduplication_key TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  -- 处理结果的一句话说明（例如"你的举报已处理：内容已隐藏"）；评论类通知为空
  detail            TEXT,
  read_at           INTEGER CHECK (read_at IS NULL OR read_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  -- 自己不通知自己：应用层漏判时这里会拒绝写入
  CHECK (recipient_id <> actor_id),
  -- 评论类 ⇔ 有 comment_id
  CHECK ((kind IN ('comment_on_content', 'reply_to_comment')) = (comment_id IS NOT NULL)),
  -- 处理结果 ⇔ 有 detail
  CHECK ((kind = 'moderation_result') = (detail IS NOT NULL)),
  UNIQUE (deduplication_key)
);

INSERT INTO notifications_new
  (id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, detail, read_at, created_at)
SELECT
  id, recipient_id, kind, actor_id, comment_id, content_entity_id, deduplication_key, NULL, read_at, created_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_inbox ON notifications(recipient_id, read_at, created_at DESC, id);

COMMIT;

PRAGMA foreign_keys = ON;

-- 自检：重建后必须没有悬空外键（迁移器随后还会跑一次 foreignKeyCheck，这里先挡一道）
PRAGMA foreign_key_check;
