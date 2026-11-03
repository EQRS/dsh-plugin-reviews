-- dsh:migration-transaction=off
-- 0037_forum.sql
--
-- 讨论区：分区 / 帖子 / 两层回复 / 点赞 / 分区申请。
--
-- 本文件自管事务（含 notifications 重建：FK OFF → BEGIN → 建新 → 拷 → 删旧 →
-- 改名 → 建索引 → COMMIT → FK ON），因此顶部带 dsh:migration-transaction=off。
--
-- 几条刻意的取舍：
--   * **回复只有两层**：parent_id 为 NULL 是顶层回复，非 NULL 是对顶层回复的回复。
--     「回复的回复不能再有回复」由触发器兜底 —— 应用层写错也进不来，不用指望每个
--     写入口都记得这个规则。
--   * **图片只允许挂在帖子与顶层回复上**：回复的回复不允许附件，同样用触发器守。
--   * **帖子软删**：status='deleted' 保留行，回复者与收藏者看到「已被删除」而不是
--     内容凭空消失。删帖不级联删回复与点赞，那些是别人的痕迹。
--   * **计数列冗余**（like_count / reply_count / last_reply_at）：列表页要排序与显示，
--     每次 COUNT 会随帖子量线性变慢；写入时在事务内维护，比现算划算。
--   * **分区权限只在分区内生效**：forum_board_moderators 不写进 users.role，
--     站长身份与分区区长是两件事，混在一起会让「这个人为什么能删帖」难以追溯。
--   * posting_policy 三态 + 黑名单叠加：白名单与黑名单不是二选一，
--     常见需求是「所有人可发，但剔除某几个捣乱的」。

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE forum_boards (
  id              TEXT    PRIMARY KEY,
  slug            TEXT    NOT NULL CHECK (trim(slug) <> '' AND length(slug) <= 60),
  name            TEXT    NOT NULL CHECK (trim(name) <> '' AND length(name) <= 60),
  description     TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  posting_policy  TEXT    NOT NULL DEFAULT 'everyone'
                          CHECK (posting_policy IN ('everyone', 'whitelist', 'admin_only')),
  is_official     INTEGER NOT NULL DEFAULT 0 CHECK (is_official IN (0, 1)),
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  owner_id        TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at      INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at >= 0)
);

-- slug 进 URL，全局唯一；改名不改 slug，链接不断
CREATE UNIQUE INDEX uq_forum_boards_slug ON forum_boards(slug);
CREATE INDEX idx_forum_boards_status ON forum_boards(status, is_official DESC, name);

-- 区长与协管：只在所属分区内生效
CREATE TABLE forum_board_moderators (
  board_id    TEXT    NOT NULL REFERENCES forum_boards(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  role        TEXT    NOT NULL CHECK (role IN ('owner', 'moderator')),
  granted_by  TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at  INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (board_id, user_id)
);

-- 一个分区最多一位 owner：换人要先卸任，避免两个 owner 互相罢免的死结
CREATE UNIQUE INDEX uq_forum_board_owner
  ON forum_board_moderators(board_id) WHERE role = 'owner';
CREATE INDEX idx_forum_board_moderators_by_user ON forum_board_moderators(user_id, board_id);

-- 白名单/黑名单
CREATE TABLE forum_board_posting_rules (
  board_id    TEXT    NOT NULL REFERENCES forum_boards(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  mode        TEXT    NOT NULL CHECK (mode IN ('allow', 'deny')),
  created_by  TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at  INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE forum_posts (
  id            TEXT    PRIMARY KEY,
  board_id      TEXT    NOT NULL REFERENCES forum_boards(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_id     TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title         TEXT    NOT NULL CHECK (trim(title) <> '' AND length(title) <= 120),
  body_md       TEXT    NOT NULL CHECK (length(body_md) <= 20000),
  status        TEXT    NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'deleted')),
  deleted_by    TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deleted_at    INTEGER,
  is_pinned     INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  like_count    INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  reply_count   INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  last_reply_at INTEGER,
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
  edited_at     INTEGER,
  -- 删除态必须留下「谁在什么时候删的」，软删才有意义
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_by IS NOT NULL))
);

-- 分区内列表：置顶优先，再按发布时间倒序（默认排序）
CREATE INDEX idx_forum_posts_board_created
  ON forum_posts(board_id, is_pinned DESC, created_at DESC, id);
-- 「最后回复」排序与全站最新帖
CREATE INDEX idx_forum_posts_board_last_reply
  ON forum_posts(board_id, is_pinned DESC, last_reply_at DESC, id);
CREATE INDEX idx_forum_posts_by_author ON forum_posts(author_id, created_at DESC, id);

CREATE TABLE forum_post_replies (
  id          TEXT    PRIMARY KEY,
  post_id     TEXT    NOT NULL REFERENCES forum_posts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_id   TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- NULL = 顶层回复；非 NULL = 对顶层回复的回复
  parent_id   TEXT    REFERENCES forum_post_replies(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  body_md     TEXT    NOT NULL CHECK (trim(body_md) <> '' AND length(body_md) <= 10000),
  status      TEXT    NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'deleted')),
  deleted_by  TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deleted_at  INTEGER,
  like_count  INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  created_at  INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at  INTEGER NOT NULL CHECK (updated_at >= 0),
  edited_at   INTEGER,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX idx_forum_replies_by_post ON forum_post_replies(post_id, created_at, id);
CREATE INDEX idx_forum_replies_by_parent ON forum_post_replies(parent_id, created_at, id);

-- 两层封顶：只能挂在顶层回复上。用触发器而不是 CHECK，因为要读另一行
CREATE TRIGGER trg_forum_reply_two_levels
BEFORE INSERT ON forum_post_replies
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '回复只能挂在顶层回复上（最多两层）')
   WHERE (SELECT parent_id FROM forum_post_replies WHERE id = NEW.parent_id) IS NOT NULL;
  -- 跨帖挂载同样拒绝：父子必须属于同一帖子
  SELECT RAISE(ABORT, '回复与父回复不属于同一帖子')
   WHERE (SELECT post_id FROM forum_post_replies WHERE id = NEW.parent_id) <> NEW.post_id;
END;

CREATE TABLE forum_post_likes (
  post_id    TEXT    NOT NULL REFERENCES forum_posts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX idx_forum_post_likes_by_user ON forum_post_likes(user_id, created_at DESC);

CREATE TABLE forum_post_reply_likes (
  reply_id   TEXT    NOT NULL REFERENCES forum_post_replies(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (reply_id, user_id)
);

-- 回复的回复不参与点赞（使用者口径），触发器兜底：只有顶层回复能被打分
CREATE TRIGGER trg_forum_reply_like_top_level_only
BEFORE INSERT ON forum_post_reply_likes
BEGIN
  SELECT RAISE(ABORT, '只有顶层回复可以点赞')
   WHERE (SELECT parent_id FROM forum_post_replies WHERE id = NEW.reply_id) IS NOT NULL;
END;

CREATE TABLE forum_board_applications (
  id            TEXT    PRIMARY KEY,
  applicant_id  TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name          TEXT    NOT NULL CHECK (trim(name) <> '' AND length(name) <= 60),
  slug          TEXT    NOT NULL CHECK (trim(slug) <> '' AND length(slug) <= 60),
  description   TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  reason        TEXT    NOT NULL CHECK (trim(reason) <> '' AND length(reason) <= 1000),
  status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_id   TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_note   TEXT    CHECK (review_note IS NULL OR length(review_note) <= 1000),
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  reviewed_at   INTEGER,
  -- 审过就必须有审核人与时间；没审就不能有
  CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CHECK (status = 'pending' OR reviewer_id IS NOT NULL)
);

CREATE INDEX idx_forum_applications_queue ON forum_board_applications(status, created_at, id);
-- 同一人同一 slug 只能有一份待审申请（被拒后可以再申请）
CREATE UNIQUE INDEX uq_forum_applications_pending
  ON forum_board_applications(applicant_id, slug) WHERE status = 'pending';

-- ============================================================
-- 4. 附件引用
-- ============================================================
--
-- 帖子与顶层回复都能带图；回复的回复不能（使用者口径）。
-- 「谁能引用哪个文件」沿用全站规则：只能挂本人上传的附件。
-- 「回复的回复不能挂图」放在这张表上守，而不是只靠接口不接收 —— 
-- 图片是内容的一部分，越权与违规都该在写入时刻就进不来。

CREATE TABLE forum_post_attachment_links (
  post_id    TEXT    NOT NULL REFERENCES forum_posts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  file_id    TEXT    NOT NULL REFERENCES attachment_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (post_id, file_id)
);
CREATE INDEX idx_forum_post_attachment_file ON forum_post_attachment_links(file_id, post_id);

CREATE TRIGGER trg_forum_post_attachment_owner_insert
BEFORE INSERT ON forum_post_attachment_links
BEGIN
  SELECT RAISE(ABORT, 'forum_post_attachment_links: 只能引用本人上传的附件')
   WHERE NOT EXISTS (
     SELECT 1
       FROM forum_posts p
       JOIN attachments a ON a.id = (SELECT attachment_id FROM attachment_files WHERE id = NEW.file_id)
      WHERE p.id = NEW.post_id AND a.uploaded_by = p.author_id
   );
END;

CREATE TABLE forum_reply_attachment_links (
  reply_id   TEXT    NOT NULL REFERENCES forum_post_replies(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  file_id    TEXT    NOT NULL REFERENCES attachment_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (reply_id, file_id)
);
CREATE INDEX idx_forum_reply_attachment_file ON forum_reply_attachment_links(file_id, reply_id);

CREATE TRIGGER trg_forum_reply_attachment_owner_insert
BEFORE INSERT ON forum_reply_attachment_links
BEGIN
  -- 回复的回复不允许挂图
  SELECT RAISE(ABORT, '回复的回复不能带图片')
   WHERE (SELECT parent_id FROM forum_post_replies WHERE id = NEW.reply_id) IS NOT NULL;
  -- 只能引用本人上传的附件
  SELECT RAISE(ABORT, 'forum_reply_attachment_links: 只能引用本人上传的附件')
   WHERE NOT EXISTS (
     SELECT 1
       FROM forum_post_replies r
       JOIN attachments a ON a.id = (SELECT attachment_id FROM attachment_files WHERE id = NEW.file_id)
      WHERE r.id = NEW.reply_id AND a.uploaded_by = r.author_id
   );
END;


-- ============================================================
-- 5. 种子分区
-- ============================================================
--
-- 官方公告区：仅站方管理员可发（posting_policy='admin_only'）。
-- 综合讨论区：所有登录用户可发，供站长按需改成白名单。
-- createdAt 用固定值 0 不合适（页面会显示 1970），这里取迁移执行时的当前毫秒。

INSERT INTO forum_boards (id, slug, name, description, posting_policy, is_official, status, owner_id, created_by, created_at, updated_at)
SELECT 'board_official_announcements', 'announcements', '测评站官方公告', '站方发布的公告与说明。', 'admin_only', 1, 'active', NULL,
       (SELECT id FROM users ORDER BY created_at LIMIT 1),
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE EXISTS (SELECT 1 FROM users);

INSERT INTO forum_boards (id, slug, name, description, posting_policy, is_official, status, owner_id, created_by, created_at, updated_at)
SELECT 'board_general', 'general', '综合讨论', '插件、评测、整合包之外的一切，都可以在这里聊。', 'everyone', 0, 'active', NULL,
       (SELECT id FROM users ORDER BY created_at LIMIT 1),
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE EXISTS (SELECT 1 FROM users);

-- 全新库还没有任何用户时，种子分区插不进去（created_by 非空）。
-- 这种情况下由服务层在第一个用户注册后兜底创建，见 ensureDefaultBoards()。

-- ============================================================
-- 6. 通知类型
-- ============================================================
--
-- 新增三个 kind：回复你的帖子 / 回复你的回复 / 分区申请结果。
-- 三者都不挂 content_entities（讨论区不是内容实体），靠 detail + 未来加 link_url 承载。
--
-- 沿用 0016 的重建方式。

CREATE TABLE notifications_new (
  id                TEXT    PRIMARY KEY,
  recipient_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind              TEXT    NOT NULL CHECK (kind IN ('comment_on_content', 'reply_to_comment', 'moderation_result', 'forum_reply', 'forum_reply_to_reply', 'forum_board_application')),
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  content_entity_id TEXT    REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  deduplication_key TEXT    NOT NULL CHECK (trim(deduplication_key) <> ''),
  detail            TEXT,
  read_at           INTEGER CHECK (read_at IS NULL OR read_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (recipient_id <> actor_id),
  CHECK ((kind IN ('comment_on_content', 'reply_to_comment')) = (comment_id IS NOT NULL)),
  CHECK ((kind IN ('moderation_result', 'forum_reply', 'forum_reply_to_reply', 'forum_board_application')) = (detail IS NOT NULL)),
  CHECK (kind IN ('moderation_result', 'forum_reply', 'forum_reply_to_reply', 'forum_board_application') OR content_entity_id IS NOT NULL),
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
