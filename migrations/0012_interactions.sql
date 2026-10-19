-- 0012_interactions.sql
--
-- 互动三件套的数据层：有帮助 / 收藏 / 举报（`idea.md §13`、§15、§20）。
--
-- 表名沿用 `数据库模型.md` 的规划（`review_helpful_votes` / `plugin_favorites` / `reports` /
-- `report_handling_records`），这样代码与规划文档能对得上。
--
-- 几条刻意的取舍：
--   * **有帮助是"一人一票 + 可取消"**：主键 (user_id, review_id) 天然保证一人一票；
--     取消就是删行，不需要软删除。计数值始终由 COUNT 现算，不做冗余计数列
--     （少一处可能漂移的地方；量级在千级以内，COUNT 完全够）。
--   * **收藏只在登录用户与目标之间**：P1 先做插件收藏；整合包收藏等 `plugin_packs` 建好
--     （P4）再加 —— 现在建一张指向不存在表的外键，`foreign_key_check` 会直接报错。
--   * **举报的"目标"用 content_entity_id 统一指向**：评测与整合包版本都是 `content_entities`
--     的一行（整合包版本在 P4 放开 content_type 闸门后即可进来），评论额外带 `comment_id`。
--     这样不做多态外键，也不会在未来多一张表时改结构。
--   * **同一人 + 同一目标 + 同一原因，只允许存在一条未处理的举报**（部分唯一索引）：
--     防刷但不妨碍"处理完之后再举报一次"。
--   * 处理动作单独一张 `report_handling_records`（而不是在 reports 上盖状态字段）：
--     §23 要求"已处理事项进入历史记录，方便追查"，一条举报可能被多次处理（如先要求补证据再隐藏）。

CREATE TABLE review_helpful_votes (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_id  TEXT    NOT NULL REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, review_id)
);

-- 评测详情要算总数；列表页暂不显示（§13：默认仍按发布时间排，不做按有帮助数排序）
CREATE INDEX idx_review_helpful_by_review ON review_helpful_votes(review_id);

CREATE TABLE plugin_favorites (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  plugin_id  TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, plugin_id)
);

-- 个人中心"收藏的插件"按时间倒序；同时服务"我收藏了吗"的单点查询
CREATE INDEX idx_plugin_favorites_by_user ON plugin_favorites(user_id, created_at DESC, plugin_id);

CREATE TABLE reports (
  id                TEXT    PRIMARY KEY,
  reporter_id       TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  target_kind       TEXT    NOT NULL CHECK (target_kind IN ('review', 'comment', 'pack_release')),
  -- 评测 / 整合包版本 → 内容实体 id；评论 → 所属内容实体的 id（评论本身在 comment_id）
  content_entity_id TEXT    NOT NULL REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  comment_id        TEXT    REFERENCES comments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reason            TEXT    NOT NULL CHECK (reason IN ('spam', 'abuse', 'misinformation', 'copyright', 'other')),
  detail            TEXT    CHECK (detail IS NULL OR length(detail) <= 2000),
  state             TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  -- 只有"评论"这个目标允许带 comment_id，其余必须为空（反过来也成立）
  CHECK ((target_kind = 'comment') = (comment_id IS NOT NULL))
);

-- 待办队列：未处理优先、先进先出
CREATE INDEX idx_reports_queue ON reports(state, created_at ASC, id);
-- 防刷：同一人对同一目标同一原因，只允许一条未处理的举报
CREATE UNIQUE INDEX idx_reports_open_dedup
  ON reports(reporter_id, target_kind, content_entity_id, reason)
  WHERE state = 'open';

CREATE TABLE report_handling_records (
  id         TEXT    PRIMARY KEY,
  report_id  TEXT    NOT NULL REFERENCES reports(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  handled_by TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action     TEXT    NOT NULL CHECK (action IN ('hide', 'dismiss', 'request_evidence')),
  -- §23：处理必须记录原因；空原因等于没记录
  reason     TEXT    NOT NULL CHECK (trim(reason) <> ''),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX idx_report_handling_by_report ON report_handling_records(report_id, created_at DESC, id);

-- ---------------------------------------------------------------------------
-- 评论的管理员隐藏（`idea.md §20`：违规内容可以隐藏，并记录处理原因）
--
-- 为什么单独三列而不是复用 deleted_at：
--   * 作者删除是"本人撤下"，管理员隐藏是"违规处理" —— 页面文案、申诉路径、审计都不同，
--     混用一个字段会让"谁删的、为什么"永久丢失；
--   * 读模型也要区别对待：作者删除在有回复时留占位，管理员隐藏的评论**整条不展示**。
--
-- 这三列不重建表（comments 被 notifications.comment_id 外键引用，重建代价大），
-- "同时为空或同时非空"用触发器钉住（与 0002 的写法一致）。
-- ---------------------------------------------------------------------------

ALTER TABLE comments ADD COLUMN hidden_at INTEGER;
ALTER TABLE comments ADD COLUMN hidden_by TEXT REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE comments ADD COLUMN hidden_reason TEXT;

CREATE TRIGGER trg_comments_hidden_triplet_insert
BEFORE INSERT ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments: 新评论不得预先带隐藏字段')
  WHERE NEW.hidden_at IS NOT NULL OR NEW.hidden_by IS NOT NULL OR NEW.hidden_reason IS NOT NULL;
END;

CREATE TRIGGER trg_comments_hidden_triplet_update
BEFORE UPDATE OF hidden_at, hidden_by, hidden_reason ON comments
BEGIN
  SELECT RAISE(ABORT, 'comments: 隐藏时间/操作者/原因必须同时填写或同时为空')
  WHERE (NEW.hidden_at IS NULL) <> (NEW.hidden_by IS NULL AND NEW.hidden_reason IS NULL);
END;