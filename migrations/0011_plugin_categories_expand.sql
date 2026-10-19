-- 0011_plugin_categories_expand.sql
--
-- 补认领一批**真用途** topic（来自线上 `listTopicUsage()` 的未归类清单，按覆盖仓库数排序看出来的）。
--
-- 判断标准：这个 topic 是否描述"插件干什么用"。
--   * `skills` / `agent-skills` / `ai-agent(s)` / `agentic-os` / `agentic-runtime` / `agent-infrastructure` → 多智能体
--   * `code-review` / `ai-coding` / `ai-ide` → 代码与编程
--   * `developer-tools` → 工具与终端
--   * `video-generation` / `video` → 媒体与内容
--
-- **仍然不认领**（它们只说明"这是个 DSH 插件"，不说明用途）：
--   dsh / dsh-plugin / dsh-plugins / dsh-plugin-market / deepseek / deepseek-harness / plugin / llm / cordis
-- 这些留在"未分类"里是对的：未分类数量本身就是"运营待办"的度量，不该靠认领噪声把它清零。
--
-- 为什么不改 0010：迁移一旦应用就不再修改（线上已跑过 0010）。新装环境按顺序执行会得到同样结果。

UPDATE plugin_categories
   SET topics = '["multi-agent","agent","agents","agentic","agentic-ai","agent-framework","ai-agent-framework","agent-teams","agent-runtime","subagent","orchestration","ai-agent","ai-agents","agentic-os","agentic-runtime","agent-infrastructure","skills","agent-skills","ai-sdk"]',
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE slug = 'agents';

UPDATE plugin_categories
   SET topics = '["codegraph","code","coding","codex","refactor","ast","lsp","git","code-review","ai-coding","ai-ide"]',
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE slug = 'code';

UPDATE plugin_categories
   SET topics = '["terminal","tty","ssh","shell","cli","command","ftp","sftp","process","developer-tools"]',
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE slug = 'tools';

UPDATE plugin_categories
   SET topics = '["ffmpeg","image","video","audio","media","markdown","writing","documents","ocr","video-generation"]',
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE slug = 'media';
