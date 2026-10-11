-- 0002_triggers.sql
-- 受限不可变与跨行归属校验。
--
-- 这些规则 SQLite 的 CHECK 表达不了（需要跨行 SELECT），按数据库模型第 4、5 节
-- 使用受限 BEFORE INSERT/UPDATE 触发器实现。触发器是本切片的**真实迁移内容**，
-- 测试直接查 sqlite_master 断言其存在（防止被漏掉或被"简化"掉）。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. 公共内容与子类型配对（延迟 NO ACTION 外键的补充校验）
-- ============================================================
-- content_entities 与 reviews 互指，用延迟外键在 commit 时配对；
-- 这里额外拒绝"公共记录指向一个不存在的评测回指"。

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

-- 公共内容 ID 不得同时对应评测与整合包版本
CREATE TRIGGER trg_content_entities_no_type_switch
BEFORE UPDATE OF content_type ON content_entities
BEGIN
  SELECT RAISE(ABORT, 'content_entities: 公共内容类型不可变更')
  WHERE NEW.content_type <> OLD.content_type;
END;

-- ============================================================
-- 2. 评测修订指针必须属于本篇（架构第 34.1 节）
-- ============================================================

CREATE TRIGGER trg_reviews_revision_pointers_insert
BEFORE INSERT ON reviews
BEGIN
  SELECT RAISE(ABORT, 'reviews: published_revision_id 不属于本篇评测')
  WHERE NEW.published_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM review_revisions r
      WHERE r.id = NEW.published_revision_id AND r.review_id = NEW.id
    );
  SELECT RAISE(ABORT, 'reviews: latest_submitted_revision_id 不属于本篇评测')
  WHERE NEW.latest_submitted_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM review_revisions r
      WHERE r.id = NEW.latest_submitted_revision_id AND r.review_id = NEW.id
    );
END;

CREATE TRIGGER trg_reviews_revision_pointers_update
BEFORE UPDATE OF published_revision_id, latest_submitted_revision_id ON reviews
BEGIN
  SELECT RAISE(ABORT, 'reviews: published_revision_id 不属于本篇评测')
  WHERE NEW.published_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM review_revisions r
      WHERE r.id = NEW.published_revision_id AND r.review_id = NEW.id
    );
  SELECT RAISE(ABORT, 'reviews: latest_submitted_revision_id 不属于本篇评测')
  WHERE NEW.latest_submitted_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM review_revisions r
      WHERE r.id = NEW.latest_submitted_revision_id AND r.review_id = NEW.id
    );
  -- 有公开修订时，文章的插件关联必须与该修订一致（架构第 34.1 节）
  SELECT RAISE(ABORT, 'reviews: 公开修订的插件关联与文章当前关联不一致')
  WHERE NEW.published_revision_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM review_revisions r
      WHERE r.id = NEW.published_revision_id AND r.plugin_id IS NOT NEW.plugin_id
    );
END;

-- ============================================================
-- 3. 评论盖楼归属（架构第 79.1 节）
-- ============================================================

-- 回复：被回复对象与 root 必须同属一个公共内容，且 root 必须是顶层评论。
CREATE TRIGGER trg_comments_reply_group_insert
BEFORE INSERT ON comments
WHEN NEW.reply_to_comment_id IS NOT NULL
BEGIN
  -- 被回复评论必须存在、同目标
  SELECT RAISE(ABORT, 'comments: 被回复评论不属于同一公共内容')
  WHERE NOT EXISTS (
    SELECT 1 FROM comments c
    WHERE c.id = NEW.reply_to_comment_id AND c.content_entity_id = NEW.content_entity_id
  );
  -- root 必须存在、同目标、且确为顶层
  SELECT RAISE(ABORT, 'comments: root_comment_id 不属于同一公共内容')
  WHERE NOT EXISTS (
    SELECT 1 FROM comments c
    WHERE c.id = NEW.root_comment_id AND c.content_entity_id = NEW.content_entity_id
  );
  SELECT RAISE(ABORT, 'comments: root_comment_id 必须指向顶层评论')
  WHERE NOT EXISTS (
    SELECT 1 FROM comments c
    WHERE c.id = NEW.root_comment_id
      AND c.reply_to_comment_id IS NULL AND c.root_comment_id IS NULL
  );
  -- root 必须等于"被回复对象的顶层"：被回复者是顶层则取自身，否则取其 root
  SELECT RAISE(ABORT, 'comments: root 与被回复对象的讨论组不一致')
  WHERE NEW.root_comment_id IS NOT (
    SELECT CASE WHEN c.reply_to_comment_id IS NULL THEN c.id ELSE c.root_comment_id END
    FROM comments c WHERE c.id = NEW.reply_to_comment_id
  );
END;

-- 目标与回复关系创建后固定，不允许通过更新迁移到其他文章或讨论组。
CREATE TRIGGER trg_comments_fixed_relations
BEFORE UPDATE OF content_entity_id, reply_to_comment_id, root_comment_id, author_id ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments: 目标、作者与回复关系创建后不可修改')
  WHERE NEW.content_entity_id IS NOT OLD.content_entity_id
     OR NEW.author_id IS NOT OLD.author_id
     OR NEW.reply_to_comment_id IS NOT OLD.reply_to_comment_id
     OR NEW.root_comment_id IS NOT OLD.root_comment_id;
END;

-- ============================================================
-- 4. 评论修订指针必须属于本评论
-- ============================================================

CREATE TRIGGER trg_comments_revision_pointers_insert
BEFORE INSERT ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments: published_revision_id 不属于本评论')
  WHERE NEW.published_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM comment_revisions r
      WHERE r.id = NEW.published_revision_id AND r.comment_id = NEW.id
    );
END;

CREATE TRIGGER trg_comments_revision_pointers_update
BEFORE UPDATE OF published_revision_id, latest_submitted_revision_id ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments: published_revision_id 不属于本评论')
  WHERE NEW.published_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM comment_revisions r
      WHERE r.id = NEW.published_revision_id AND r.comment_id = NEW.id
    );
  SELECT RAISE(ABORT, 'comments: latest_submitted_revision_id 不属于本评论')
  WHERE NEW.latest_submitted_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM comment_revisions r
      WHERE r.id = NEW.latest_submitted_revision_id AND r.comment_id = NEW.id
    );
END;

-- ============================================================
-- 5. 提交快照的类型与归属（架构第 38.1 节）
-- ============================================================

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

-- ============================================================
-- 6. 不可变快照：修订与任务执行记录的历史字段
-- ============================================================

-- 评测修订提交后不可改写（架构第 34.2 节）
CREATE TRIGGER trg_review_revisions_immutable
BEFORE UPDATE ON review_revisions
BEGIN
  SELECT RAISE(ABORT, 'review_revisions: 提交后不可改写');
END;

CREATE TRIGGER trg_review_revisions_no_delete
BEFORE DELETE ON review_revisions
BEGIN
  SELECT RAISE(ABORT, 'review_revisions: 历史快照不可删除');
END;

-- 评论修订提交后不可改写
CREATE TRIGGER trg_comment_revisions_immutable
BEFORE UPDATE ON comment_revisions
BEGIN
  SELECT RAISE(ABORT, 'comment_revisions: 提交后不可改写');
END;

CREATE TRIGGER trg_comment_revisions_no_delete
BEFORE DELETE ON comment_revisions
BEGIN
  SELECT RAISE(ABORT, 'comment_revisions: 历史快照不可删除');
END;

-- 任务尝试结束后不可改写（架构第 48.2 节）
CREATE TRIGGER trg_attempts_no_rewrite_after_finish
BEFORE UPDATE ON background_task_attempts
WHEN OLD.outcome IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'background_task_attempts: 已结束的执行记录不可改写');
END;

-- ============================================================
-- 7. 内容控制版本：撤回/隐藏变化时递增（服务层负责写值，这里兜底）
-- ============================================================

CREATE TRIGGER trg_content_entities_visibility_version
BEFORE UPDATE OF withdrawn_at, hidden_at ON content_entities
BEGIN
  SELECT RAISE(ABORT, 'content_entities: 可见性控制变化必须递增 visibility_control_version')
  WHERE NEW.visibility_control_version <= OLD.visibility_control_version;
END;
