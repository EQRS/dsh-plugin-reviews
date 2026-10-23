-- 0018_draft_soft_delete.sql
--
-- 草稿软删除：已提交过的草稿被 content_submissions.draft_id（ON DELETE RESTRICT）引用，
-- 不能物理删除；而用户需要「删除草稿」时能连同已发布评测一起撤回。
--
-- 设计取舍：
--   * 未提交过的草稿仍然物理删除（没有历史需要保留）；
--   * 已提交/已发布的草稿改为软删除（deleted_at 标记 + review_id 置 NULL 释放唯一索引），
--     提交记录与修订快照保留，撤回语义由 content_entities.withdrawn_at 表达；
--   * 列表/详情/保存统一过滤 deleted_at IS NULL，删除后不可再读写。
ALTER TABLE content_drafts ADD COLUMN deleted_at INTEGER;

-- 原唯一索引按 review_id 覆盖所有 review 草稿；软删除行会继续占用它，
-- 导致「删除后想重新写同一评测」插入失败。改为只约束**未删除**的草稿。
DROP INDEX uq_drafts_review;
CREATE UNIQUE INDEX uq_drafts_review
  ON content_drafts(review_id) WHERE draft_type = 'review' AND deleted_at IS NULL;

CREATE INDEX idx_drafts_owner_active ON content_drafts(owner_id, deleted_at, saved_at DESC, id);
