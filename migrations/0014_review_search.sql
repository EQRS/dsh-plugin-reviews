-- 0014_review_search.sql
--
-- 评测全文检索（`idea.md §16`/§22：全站评测页支持关键词搜索、命中标题/正文/插件名，按匹配程度排序）。
--
-- 为什么用 FTS5 + `trigram` 分词：
--   * SQLite 的 `unicode61` 按"词"切，中文整段算一个词，**子串搜不到**（搜"记忆"匹配不了"记忆插件"）；
--   * `trigram` 做的是三字滑窗索引 → 中文/英文的**子串**都能命中。
--   * ⚠️ 实测边界：trigram **只对 ≥3 个字符的查询生效**（"中文检"命中，"记忆"这种 2 字查询返回 0 条）。
--     所以检索层必须对 1–2 字查询走 `LIKE` 回退 —— 这条写在 `modules/search` 里，并有测试钉住。
--
-- 表结构取舍：
--   * 用**独立**的 FTS 表（不是 external content）：我们索引的三个字段来自三张表
--     （review_revisions / content_entities / plugins+repositories），external content 要求列来自同一张表；
--   * `review_id UNINDEXED`：只作为从命中行回查业务表的键，不参与全文匹配；
--   * 索引在**发布**时写入（`workflows/publish-review`），撤回/隐藏不改索引 —— 可见性在查询时统一解析，
--     旧索引行不会让一篇已撤回的文章出现在结果里（有测试钉住这一点）。

CREATE VIRTUAL TABLE review_search USING fts5(
  review_id UNINDEXED,
  title,
  body,
  plugin_name,
  tokenize = 'trigram'
);
