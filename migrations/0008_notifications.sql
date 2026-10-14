-- 0008_notifications.sql
--
-- 站内通知（`idea.md §11`：新评论通知内容作者、回复通知被回复人；公开后才发；自己不通知自己；
-- 同一事件不重复；顶部有未读数）。
--
-- 设计取舍（如实写在迁移里，便于将来对照）：
--   * **不做 `business_events` / `event_delivery_tasks` 那一整层**。架构里那层是为了可重试的扇出
--     （邮件/外部 webhook）。本切片只需要站内一条记录，投递点就在**评论发布那个事务里**
--     （那一刻评论才公开，语义天然正确），失败即随发布事务回滚，不会出现"通知发了但评论没公开"。
--     将来要加邮件/推送，再补事件层与投递任务，不必现在建三张空表。
--   * **"同一事件不重复"做成数据库约束**（`UNIQUE (deduplication_key)`），而不是靠应用层先查后插 ——
--     并发下两个发布任务同时跑也不会插出两条。
--   * **"自己不通知自己"也做成 CHECK**（`recipient_id <> actor_id`）：应用层忘了判断时数据库会拒绝，
--     这种"安静的错"必须让它在写入时就炸。
--   * 去重键刻意用 **评论** 而不是 **修订**：编辑评论会换新修订，但那不是"新评论"，
--     不该再通知一次（键 = comment_published:<评论>:<收件人>）。
--   * `read_at` 可空：空 = 未读（未读数就是按它统计）。

CREATE TABLE notifications (
  id                TEXT    PRIMARY KEY,
  recipient_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('comment_on_content','reply_to_comment')),
  -- 触发者与来源对象（都是外键：用户/评论/内容实体被引用着就删不掉，避免通知指向空气）
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    NOT NULL REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_entity_id TEXT    NOT NULL REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 同一事件只发一次（见上：按评论而非修订）
  deduplication_key TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  read_at           INTEGER CHECK (read_at IS NULL OR read_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  -- 自己不通知自己：应用层漏判时这里会拒绝写入
  CHECK (recipient_id <> actor_id),
  UNIQUE (deduplication_key)
);

-- 收件箱查询与未读数共用：按收件人 + 未读 + 时间倒序
CREATE INDEX idx_notifications_inbox ON notifications(recipient_id, read_at, created_at DESC, id);
