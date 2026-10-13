-- 0005_plugin_directory_info.sql
-- 为「插件目录能搜、能筛、卡片有真内容」补展示字段。
--
-- 为什么现在才加：最小切片刻意只存"身份"（仓库 + 子路径 + 归档态），
-- 展示字段一律留空 —— 结果是目录页只有"仓库全名"，首页还写着"搜索/分类/筛选见插件目录"
-- 而目录里并没有。这些字段**本来就躺在探针已经拿到的响应里**（GitHub 仓库 JSON 与
-- package.json），只是当初被丢掉了，所以本迁移不引入任何新的外部调用。
--
-- 口径（必须写清，否则会被误读）：
--   * repositories.*  = 仓库级资料（来自 GitHub 仓库 JSON）
--   * plugins.*       = 插件级资料（来自该子目录的 package.json 清单）
--   * plugins.info_updated_at = **本站最后一次成功写入这些展示字段的时间**，
--     不等于"仓库在 GitHub 上的更新时间"（后者是 repositories.repo_updated_at，仅展示）。
--   * 所有字段可空：拿不到就留 NULL，页面显示"暂无"，**不用空字符串或猜测值冒充**。
--
-- 约束风格与 0001-0004 一致：TS=UTC 毫秒 INTEGER，JSON 列走 json_valid CHECK。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. 仓库级资料
-- ============================================================

ALTER TABLE repositories ADD COLUMN description TEXT;

-- GitHub topics（用途标签的来源）。存 JSON 数组文本；非数组/非法 JSON 一律不写（留 NULL）。
ALTER TABLE repositories ADD COLUMN topics TEXT
  CHECK (topics IS NULL OR json_valid(topics));

ALTER TABLE repositories ADD COLUMN owner_login TEXT;

-- 仅用于列表图标（owner 头像）。**只存外链，不做代理与缓存**（本切片不引入图片代理）。
ALTER TABLE repositories ADD COLUMN owner_avatar_url TEXT;

-- GitHub 仓库的 updated_at（UTC 毫秒）。只用于展示"仓库更新于"，**不参与排序口径**。
ALTER TABLE repositories ADD COLUMN repo_updated_at INTEGER
  CHECK (repo_updated_at IS NULL OR repo_updated_at >= 0);

-- ============================================================
-- 2. 插件级资料（来自该子目录 package.json）
-- ============================================================

-- 清单里的 name。为空时页面回退到"仓库全名 + 子路径"，不在这里补默认值。
ALTER TABLE plugins ADD COLUMN display_name TEXT;
ALTER TABLE plugins ADD COLUMN description TEXT;
-- 清单 author：可能是字符串，也可能是 {name,email} 对象 —— 适配器负责归一成字符串。
ALTER TABLE plugins ADD COLUMN author_login TEXT;
-- 清单 version：**只是清单声明的版本**，不代表任何"已实测"或兼容性承诺。
ALTER TABLE plugins ADD COLUMN manifest_version TEXT;
ALTER TABLE plugins ADD COLUMN info_updated_at INTEGER
  CHECK (info_updated_at IS NULL OR info_updated_at >= 0);

-- ============================================================
-- 3. 浏览序的索引
-- ============================================================
-- 目录默认按"资料更新时间倒序"翻页，排序键是 (updated_at DESC, id ASC)（带 id 兜底保证不重不漏）。
CREATE INDEX idx_plugins_updated_id ON plugins (updated_at DESC, id ASC);
