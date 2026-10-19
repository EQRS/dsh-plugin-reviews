-- 0010_plugin_categories.sql
--
-- 用途分类：把 GitHub topics 映射成**可维护的中文分类**。
--
-- 为什么需要这一层（来自线上实测的三个问题）：
--   1) 之前 chip 行直接拿 topics 当标签，噪声极大：`dsh-plugin` 覆盖 46/50 个插件、
--      `deepseek-harness` 40 个 —— 这种"自指标签"几乎没有区分度；
--   2) 仓库级 topics 会被复制到该仓库的每个子插件，一个 11 包的 monorepo 能让
--      docker/rss/ftp/ssh 这些标签各 +11，计数被单仓放大；
--   3) 标签全是英文原样，没有中文口径，用户看不出"这是干什么用的"。
--
-- 设计取舍：
--   * **分类是数据，不是代码**：后台可增删改（`plugin_categories`），新增一个分类不用发版。
--   * `topics` 存该分类认领的 GitHub topics（JSON 数组，小写）——**一个 topic 只应属于一个分类**
--     （聚合时按 slug 排序取第一个，重复认领不会重复计数，但语义上应当避免）。
--   * 没有命中任何分类的仓库显示为「未分类」（`__none__`，是计算出来的，不落表）。
--   * 原始 topics 仍然保留在 `repositories.topics`，详情页照样展示 —— 只是**不再当作筛选 chip**。

CREATE TABLE plugin_categories (
  slug       TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  topics     TEXT NOT NULL CHECK (json_valid(topics)),
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_plugin_categories_order ON plugin_categories (is_visible, sort_order, slug);

-- 种子分类：按线上实际 topics 归纳（不是凭空设计的十个盒子）。
-- 明确**不认领**的噪声 topic：dsh / dsh-plugin / dsh-plugins / deepseek-harness / plugin / ai / llm ——
-- 它们只说明"这是个 DSH 插件"，不说明用途。
INSERT INTO plugin_categories (slug, label, topics, sort_order, is_visible, created_at, updated_at) VALUES
  ('memory',       '记忆与知识', '["memory","agent-memory","persistent-memory","rag","knowledge-graph","vector","embedding","context"]', 10, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('search',       '搜索与检索', '["search","global-search","web-search","retrieval","index","grep"]', 20, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('agents',       '多智能体',   '["multi-agent","agent","agents","agentic","agentic-ai","agent-framework","ai-agent-framework","agent-teams","agent-runtime","subagent","orchestration"]', 30, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('security',     '安全与护栏', '["security","agent-security","guardrails","agent-safety","safety","sandbox","permission","audit"]', 40, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('tools',        '工具与终端', '["terminal","tty","ssh","shell","cli","command","ftp","sftp","process"]', 50, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('data',         '数据与存储', '["docker","database","sqlite","postgres","storage","rss","email","sync","backup"]', 60, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('code',         '代码与编程', '["codegraph","code","coding","codex","refactor","ast","lsp","git"]', 70, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('media',        '媒体与内容', '["ffmpeg","image","video","audio","media","markdown","writing","documents","ocr"]', 80, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('integration',  '集成与协议', '["mcp","mcp-ui","api","integration","webhook","openai","provider","chatgpt","dingtalk"]', 90, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000),
  ('ui',           '界面与交互', '["ui","tui","theme","design","frontend","profile","dashboard"]', 100, 1, strftime('%s','now') * 1000, strftime('%s','now') * 1000);
