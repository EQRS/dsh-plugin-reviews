-- dsh:migration-transaction=off
--
-- 0038_forum_drafts_and_moderation.sql
--
-- 讨论区补三件事：发帖前草稿、发帖自动审核、帖子与回复可被举报。
--
-- 说明与取舍：
--   * **草稿独立成表**而不是在 forum_posts 上加 status：草稿不需要 title 之外的
--     slug/置顶/计数，混进同一张表会让每条列表查询都要记得排除它，漏一处就泄漏。
--   * **自动审核记录独立成表**：与内容实体的 moderation_records 不同，讨论区不是
--     content_entities，硬塞进去要编假引用。这里只记「哪条规则、什么结论、命中什么」。
--   * **自动审核绝不自动放行违规**：规则只是把明显有问题的挡下来交人工；
--     没有命中任何规则就正常发布。这是与内容审核（未配置筛查时停在人工）的差别：
--     讨论区没有外部内容筛查供应商，规则是本地正则，判不了「可疑」，只能判「明确命中」。
--   * **举报目标扩展**：reports.target_kind 增加 post / forum_reply，且这两类不需要
--     content_entity_id。重建 reports 表以放宽 CHECK。

PRAGMA foreign_keys = OFF;

BEGIN;

-- ============================================================
-- 1. 帖子草稿
-- ============================================================

CREATE TABLE forum_post_drafts (
  id            TEXT    PRIMARY KEY,
  author_id     TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  board_id      TEXT    NOT NULL REFERENCES forum_boards(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title         TEXT    NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  body_md       TEXT    NOT NULL DEFAULT '' CHECK (length(body_md) <= 20000),
  -- 草稿允许标题或正文为空（写一半很正常），发布时才校验
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
  submitted_at  INTEGER,
  UNIQUE (id, author_id)
);

CREATE INDEX idx_forum_post_drafts_by_author ON forum_post_drafts(author_id, updated_at DESC, id);

-- 草稿引用的图片：与内容草稿同一套「只能引用本人上传的附件」规则
CREATE TABLE forum_post_draft_attachment_links (
  draft_id   TEXT    NOT NULL REFERENCES forum_post_drafts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  file_id    TEXT    NOT NULL REFERENCES attachment_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (draft_id, file_id)
);

CREATE TRIGGER trg_forum_draft_attachment_owner_insert
BEFORE INSERT ON forum_post_draft_attachment_links
BEGIN
  SELECT RAISE(ABORT, 'forum_post_draft_attachment_links: 只能引用本人上传的附件')
   WHERE NOT EXISTS (
     SELECT 1
       FROM forum_post_drafts d
       JOIN attachments a ON a.id = (SELECT attachment_id FROM attachment_files WHERE id = NEW.file_id)
      WHERE d.id = NEW.draft_id AND a.uploaded_by = d.author_id
   );
END;

-- ============================================================
-- 2. 帖子自动审核记录
-- ============================================================

CREATE TABLE forum_post_screenings (
  id          TEXT    PRIMARY KEY,
  post_id     TEXT    NOT NULL REFERENCES forum_posts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 命中的规则名（如 spam_link / banned_word / all_caps_title）；空串 = 未命中任何规则
  rule        TEXT    NOT NULL DEFAULT '' CHECK (length(rule) <= 60),
  -- passed = 放行；blocked = 挡下交人工；
  verdict     TEXT    NOT NULL CHECK (verdict IN ('passed', 'blocked')),
  detail      TEXT    NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
  created_at  INTEGER NOT NULL CHECK (created_at >= 0),
  -- 放行不该带 detail（没有可说的）；挡下必须说明为什么
  CHECK ((verdict = 'blocked') = (detail <> ''))
);

CREATE INDEX idx_forum_post_screenings_by_post ON forum_post_screenings(post_id, created_at);

-- 帖子加审核状态：被自动审核挡下的帖子不进公开列表，等人工处理
ALTER TABLE forum_posts ADD COLUMN review_state TEXT NOT NULL DEFAULT 'published'
  CHECK (review_state IN ('published', 'pending_review'));

CREATE INDEX idx_forum_posts_review_state ON forum_posts(review_state, created_at DESC, id);

-- ============================================================
-- 3. 举报目标扩展（重建 reports）
-- ============================================================

CREATE TABLE reports_new (
  id                TEXT    PRIMARY KEY,
  reporter_id       TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  target_kind       TEXT    NOT NULL CHECK (target_kind IN ('review', 'comment', 'pack_release', 'post', 'forum_reply')),
  content_entity_id TEXT    REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  post_id           TEXT    REFERENCES forum_posts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  forum_reply_id    TEXT    REFERENCES forum_post_replies(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason            TEXT    NOT NULL CHECK (reason IN ('spam','abuse','misinformation','copyright','other')),
  detail            TEXT    CHECK (detail IS NULL OR length(detail) <= 1000),
  state             TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','dismissed')),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  -- 每种目标类型只填自己那一列：多态外键用 CHECK 收口，避免四列都填或都不填。
  -- 注意 content_entity_id 的口径沿用 0012：评测 / 整合包版本填它自己，**评论填所属内容实体**，
  -- 所以它只对讨论区两类目标必须为空，不能写成"只有 review/pack_release 才非空"。
  CHECK ((target_kind IN ('review','pack_release','comment')) = (content_entity_id IS NOT NULL)),
  CHECK ((target_kind = 'comment') = (comment_id IS NOT NULL)),
  CHECK ((target_kind = 'post') = (post_id IS NOT NULL)),
  CHECK ((target_kind = 'forum_reply') = (forum_reply_id IS NOT NULL))
);

INSERT INTO reports_new
  (id, reporter_id, target_kind, content_entity_id, comment_id, post_id, forum_reply_id, reason, detail, state, created_at)
SELECT
  id, reporter_id, target_kind, content_entity_id, comment_id, NULL, NULL, reason, detail, state, created_at
FROM reports;

DROP TABLE reports;

ALTER TABLE reports_new RENAME TO reports;

-- 同一人 + 同一目标 + 同一原因只允许一条未处理的举报（与 0012 同口径）。
-- content_entity_id 对评论/帖子恒为 NULL，只靠它去重会把不同评论当成同一个目标，
-- 所以把后三类目标各自的 id 也并进索引键。
CREATE UNIQUE INDEX uq_reports_open_same
  ON reports(reporter_id, target_kind, content_entity_id, comment_id, post_id, forum_reply_id, reason)
  WHERE state = 'open';

CREATE INDEX idx_reports_queue ON reports(state, created_at, id);

COMMIT;

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
