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
  -- 与接口校验（interactions 举报提交）和前端计数文案一致：2000。这里不能收紧成 1000，
  -- 否则接口放行的 1000-2000 字说明会在落库时被 CHECK 拒掉。
  detail            TEXT    CHECK (detail IS NULL OR length(detail) <= 2000),
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
--
-- ⚠️ 不能把四个目标列平铺进同一个唯一索引键：SQLite 的唯一索引把 NULL 视为互不相等，
-- 而上面的 CHECK 保证每行**恰好一类**目标列非空、其余全为 NULL —— 四列一起进键，
-- 任何两行都必在某列上一个 NULL、一个非 NULL，于是永远判为"不重复"，
-- 对五类目标全部失效（0012 的 idx_reports_open_dedup 又随重建一起没了，等于举报去重整体回归）。
-- 正确做法是按 target_kind 拆成部分唯一索引，每个索引的键里只放这一类**恒非空**的目标列：
--   * review / pack_release：目标就是 content_entity_id 本身，两列合并成一个索引；
--   * comment：0012 的口径是 content_entity_id 填**所属内容实体**（不是评论自己），
--     所以去重键必须落在 comment_id 上，否则同一实体下的不同评论会被当成同一个目标；
--   * post / forum_reply：各自那一列。
-- WHERE 里带 target_kind，保证每个索引只覆盖自己这一类，互不干扰。
--
-- 覆盖度由 0038 自己的测试逐类实测（插两条相同举报，第二条必须被拒）。
CREATE UNIQUE INDEX uq_reports_open_review
  ON reports(reporter_id, target_kind, content_entity_id, reason)
  WHERE state = 'open' AND target_kind IN ('review', 'pack_release');

CREATE UNIQUE INDEX uq_reports_open_comment
  ON reports(reporter_id, target_kind, comment_id, reason)
  WHERE state = 'open' AND target_kind = 'comment';

CREATE UNIQUE INDEX uq_reports_open_post
  ON reports(reporter_id, target_kind, post_id, reason)
  WHERE state = 'open' AND target_kind = 'post';

CREATE UNIQUE INDEX uq_reports_open_forum_reply
  ON reports(reporter_id, target_kind, forum_reply_id, reason)
  WHERE state = 'open' AND target_kind = 'forum_reply';

CREATE INDEX idx_reports_queue ON reports(state, created_at, id);

COMMIT;

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
