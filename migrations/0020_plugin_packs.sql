-- 0020_plugin_packs.sql
--
-- 整合包（`idea.md` §26/§27；`架构设计.md` §15/§35/§36/§58；`docs/项目规划/决策记录.md` 第 11/12 条）。
--
-- 结构要点（与 `pr/37` 的轻量模型的关键区别都写在这里）：
--   * **包身份与发布版本分开**：`plugin_packs` 只存身份与「最近分配到的版本序号」；
--     每次发布生成**不可变**的 `plugin_pack_releases`，版本内容（名称/用途/Markdown/DSH 版本/
--     配置模板/实测声明）随版本冻结，改内容只能发新版。
--   * **版本 = 公共内容对象**：`plugin_pack_releases.id` 同时是 `content_entities.id`
--     （`content_type = 'pack_release'`，由迁移 0021 放开闸门），评论/举报因此能绑定**具体版本**。
--   * **条目是快照**：`plugin_pack_release_items` 保存当时的展示资料、插件版本与安装目标；
--     上游改名/发新版不会改写历史组合（§36.1）。
--   * **安装目标与命令分离**：条目只存结构化的 `install_target`（npm 包名@明确版本 / GitHub
--     仓库+完整提交+子路径），命令由 `packages/common/pack-install` 适配器生成 —— 不把命令文本
--     当第二份人工可编辑事实（§36.2）。
--   * **上传文件只是可选附件**：`plugin_pack_release_files` 挂在版本上，不是内容真相（决策记录 12）。
--
-- 版本序号（§58）：`plugin_packs.last_release_number` 初始 0，首次成功发布时在同一事务里
-- 原子 +1 并写入版本的 `release_number`；撤回不回收序号。

CREATE TABLE plugin_packs (
  id                  TEXT    PRIMARY KEY,
  author_id           TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 最近分配到的包内版本序号；0 = 还没有成功发布过任何版本
  last_release_number INTEGER NOT NULL DEFAULT 0 CHECK (last_release_number >= 0),
  created_at          INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX idx_plugin_packs_author ON plugin_packs(author_id, created_at DESC, id);

CREATE TABLE plugin_pack_releases (
  id              TEXT    PRIMARY KEY
                    REFERENCES content_entities(id) ON UPDATE RESTRICT ON DELETE RESTRICT
                    DEFERRABLE INITIALLY DEFERRED,
  pack_id         TEXT    NOT NULL REFERENCES plugin_packs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 成功发布时分配的包内序号；NULL = 尚未发布（草稿/待审快照）
  release_number  INTEGER CHECK (release_number IS NULL OR release_number > 0),
  title           TEXT    NOT NULL CHECK (trim(title) <> '' AND length(title) <= 80),
  purpose         TEXT    NOT NULL CHECK (trim(purpose) <> '' AND length(purpose) <= 2000),
  body_markdown   TEXT    NOT NULL,
  -- 统一版本结构（`VersionValue` JSON）：允许明确未知
  dsh_version     TEXT    NOT NULL CHECK (json_valid(dsh_version)),
  -- 可选配置模板：只提供查看/复制，秘密信息用占位符（§26）
  config_template TEXT,
  -- 作者实测声明：未实测 / 已实测（已实测必须带任务与结果，§26）
  test_status     TEXT    NOT NULL DEFAULT 'untested' CHECK (test_status IN ('untested', 'tested')),
  test_task       TEXT,
  test_result     TEXT,
  submitted_at    INTEGER NOT NULL CHECK (submitted_at >= 0),
  UNIQUE (pack_id, release_number),
  CHECK ((test_status = 'tested') = (test_task IS NOT NULL AND test_result IS NOT NULL))
);

-- 已发布版本的序号在包内唯一（NULL 不参与唯一约束，用部分索引表达）
CREATE UNIQUE INDEX uq_pack_release_number
  ON plugin_pack_releases(pack_id, release_number) WHERE release_number IS NOT NULL;
CREATE INDEX idx_pack_releases_by_pack ON plugin_pack_releases(pack_id, submitted_at DESC, id);

CREATE TABLE plugin_pack_release_items (
  id               TEXT    PRIMARY KEY,
  release_id       TEXT    NOT NULL REFERENCES plugin_pack_releases(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  plugin_id        TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position         INTEGER NOT NULL CHECK (position >= 0),
  -- 作者可选填：这个插件在组合里起什么作用
  purpose          TEXT    CHECK (purpose IS NULL OR length(purpose) <= 200),
  -- 提交时的展示资料快照：{ displayName, repositoryFullName, pluginPath }
  display_snapshot TEXT    NOT NULL CHECK (json_valid(display_snapshot)),
  -- 该条目选定的插件版本（`VersionValue` JSON；允许未知，不自动替换为最新版）
  plugin_version   TEXT    NOT NULL CHECK (json_valid(plugin_version)),
  -- 结构化安装目标：{ kind:'npm', packageName, version } |
  --               { kind:'github', repository, commit, pluginPath } | NULL
  install_target   TEXT    CHECK (install_target IS NULL OR json_valid(install_target)),
  -- 安装目标不可用/未确认时仍可展示的来源入口
  source_url       TEXT    CHECK (source_url IS NULL OR length(source_url) <= 500),
  UNIQUE (release_id, position),
  UNIQUE (release_id, plugin_id)
);

CREATE INDEX idx_pack_release_items_plugin ON plugin_pack_release_items(plugin_id);

-- 可选附件（不是内容真相）：一个版本可以有若干附件；文件落盘路径由应用层管理
CREATE TABLE plugin_pack_release_files (
  id          TEXT    PRIMARY KEY,
  release_id  TEXT    NOT NULL REFERENCES plugin_pack_releases(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  file_name   TEXT    NOT NULL CHECK (trim(file_name) <> ''),
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  stored_path TEXT    NOT NULL CHECK (trim(stored_path) <> ''),
  created_at  INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX idx_pack_release_files_by_release
  ON plugin_pack_release_files(release_id, created_at DESC, id);

-- 收藏关联**包**本身（不随版本失效；§15）
CREATE TABLE plugin_pack_favorites (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  pack_id    TEXT    NOT NULL REFERENCES plugin_packs(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, pack_id)
);

CREATE INDEX idx_plugin_pack_favorites_by_user
  ON plugin_pack_favorites(user_id, created_at DESC, pack_id);
