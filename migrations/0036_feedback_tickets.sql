-- dsh:migration-transaction=off
-- 0036_feedback_tickets.sql
--
-- 问题反馈（分类工单）：站点自身问题的收件箱。
--
-- 三件事：
--   1. feedback_tickets：一张票 = 一次提交（类型 + 标题 + 正文 + 来源页面 + 白名单上下文）；
--   2. feedback_handling_records：每次状态变化必须留一条（含理由），审计的唯一来源；
--   3. feedback_attachment_links：截图引用（照抄 draft_attachment_links 的 owner 触发器）；
--   4. notifications 重建：加 kind feedback_result（与 0034 同一手法）。
--
-- 注意：本功能**纯私有**。没有 visibility / public_summary 字段，也没有任何对外页面；
-- 提交人看自己的票是默认行为，不需要额外的「公开」动作。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE feedback_tickets (
  id             TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('bug','feature','content','account','other')),
  title          TEXT    NOT NULL CHECK (trim(title) <> '' AND length(title) <= 120),
  body           TEXT    NOT NULL CHECK (trim(body) <> '' AND length(body) <= 5000),
  -- 提交页面的站内路径（表单自动带，用户可改）；不存完整外链。
  page_url       TEXT    CHECK (page_url IS NULL OR (page_url LIKE '/%' AND page_url NOT LIKE '//%' AND length(page_url) <= 1000)),
  page_kind      TEXT    CHECK (page_kind IS NULL OR page_kind IN ('plugin','review','pack','search','other')),
  -- 关联对象 id（插件/评测/整合包）；仅用于后台快速跳转，弱引用不建 FK。
  object_id      TEXT,
  context_json   TEXT    CHECK (context_json IS NULL OR (json_valid(context_json) AND length(context_json) <= 2000)),
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','fixed','duplicate','wontfix','unreproducible')),
  duplicate_of   TEXT    REFERENCES feedback_tickets(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submitted_by   TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at     INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at     INTEGER NOT NULL CHECK (updated_at >= created_at),
  closed_at      INTEGER CHECK (closed_at IS NULL OR closed_at >= created_at),

  -- 重复票必须指向另一张票
  CHECK ((status = 'duplicate') = (duplicate_of IS NOT NULL)),
  CHECK (duplicate_of IS NULL OR duplicate_of <> id),
  -- 终态必须有 closed_at，非终态必须没有
  CHECK ((status IN ('fixed','duplicate','wontfix','unreproducible')) = (closed_at IS NOT NULL))
);

CREATE INDEX idx_feedback_queue ON feedback_tickets(status, created_at ASC, id);
CREATE INDEX idx_feedback_mine ON feedback_tickets(submitted_by, created_at DESC, id);
CREATE INDEX idx_feedback_duplicate_of ON feedback_tickets(duplicate_of);

CREATE TABLE feedback_handling_records (
  id         TEXT    PRIMARY KEY,
  ticket_id  TEXT    NOT NULL REFERENCES feedback_tickets(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  handled_by TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action     TEXT    NOT NULL CHECK (action IN ('acknowledge','fix','duplicate','wontfix','unreproducible','reopen')),
  reason     TEXT    NOT NULL CHECK (trim(reason) <> '' AND length(reason) <= 1000),
  -- 给提交人的完整回复（可选）；缺省时通知正文用 reason。
  reply_text TEXT    CHECK (reply_text IS NULL OR (trim(reply_text) <> '' AND length(reply_text) <= 2000)),
  -- 通知是否已投递（去重键 feedback:{ticketId}:{recordId}，重试不会重复发）
  notified   INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX idx_feedback_records_ticket ON feedback_handling_records(ticket_id, created_at ASC, id);

CREATE TABLE feedback_attachment_links (
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  file_id   TEXT NOT NULL REFERENCES attachment_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  PRIMARY KEY (ticket_id, file_id)
);

CREATE INDEX idx_feedback_attachment_file ON feedback_attachment_links(file_id, ticket_id);

-- 只有提交人能引用自己上传的附件（与 draft_attachment_links 的规矩一致）：
-- 防止 A 把 B 的截图挂到自己的票上（越权引用 + 越权泄露）。
CREATE TRIGGER trg_feedback_attachment_owner_insert
BEFORE INSERT ON feedback_attachment_links
BEGIN
  SELECT RAISE(ABORT, 'feedback_attachment_links: 只能引用本人上传的附件')
  WHERE NOT EXISTS (
    SELECT 1
      FROM feedback_tickets t
      JOIN attachments a ON a.id = (SELECT attachment_id FROM attachment_files WHERE id = NEW.file_id)
     WHERE t.id = NEW.ticket_id AND a.uploaded_by = t.submitted_by
  );
END;

-- 通知：新增 kind feedback_result（无 comment_id、有 detail、可无 content_entity_id）。
CREATE TABLE notifications_new (
  id                TEXT    PRIMARY KEY,
  recipient_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('comment_on_content', 'reply_to_comment', 'moderation_result', 'featured_published', 'feedback_result')),
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_entity_id TEXT    REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deduplication_key TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  detail            TEXT,
  link_url          TEXT,
  read_at           INTEGER CHECK (read_at IS NULL OR read_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (recipient_id <> actor_id),
  CHECK ((kind IN ('comment_on_content', 'reply_to_comment')) = (comment_id IS NOT NULL)),
  CHECK ((kind IN ('moderation_result', 'featured_published', 'feedback_result')) = (detail IS NOT NULL)),
  CHECK (kind IN ('moderation_result', 'featured_published', 'feedback_result') OR content_entity_id IS NOT NULL),
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
