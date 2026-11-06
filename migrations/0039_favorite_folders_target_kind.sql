-- dsh:migration-transaction=off
-- 0039_favorite_folders_target_kind.sql
--
-- 收藏体系重构（设计文档《设计-讨论区与收藏重构》§3.4）：收藏从「插件独占」扩到
-- 插件 / 整合包 / 帖子三类内容共用一个收藏夹体系。
--
-- 本文件自管事务（要重建被外键引用的 favorite_folders），因此顶部带
-- dsh:migration-transaction=off。重建序：关 FK → 建新表 → 拷 → 删旧索引 → 删旧表 →
-- 改名 → 建新索引 → 建依赖表 → 迁移老数据 → 开 FK → foreign_key_check。
-- 顺序是被实测钉住的：旧索引必须先于新索引删（索引名库级唯一），新索引必须等改名后
-- 再建（建在新表原名上，改名后索引条件会跟着旧表名走，报 no such table）。
-- 重建后依赖表的外键会自动改指新表（含 ON DELETE CASCADE），已用探针验证。
--
-- 几条刻意的取舍：
--   * **默认夹从「全局唯一」改成「每类内容各一个」**：0019 的唯一索引只约束 user_id，
--     三类内容共用时会撞车（帖子默认夹与插件默认夹抢同一个位置）。新索引键是
--     (user_id, target_kind)。改索引必须重建表 —— SQLite 不能原地改部分索引的条件。
--   * **老数据一律归 'plugin'**：0039 之前收藏夹只有插件在用，这不是猜测。
--   * **plugin_pack_favorites 保留不删**：它是旧集成包收藏表，本迁移只是把数据拷进
--     pack_favorites 并让代码改读写新表。留一行退路远比删表安全；确认无碍后再单独清理。
--   * **收藏行不级联删除**：目标被硬删时（帖子与整合包都是软删，正常不会发生）收藏
--     行跟着删；夹被删则把收藏退回该类默认夹（见 deleteFavoriteFolder），不留孤儿。
--   * **迁移时顺手给每个已收藏的用户建好默认夹**：否则老用户进新页面第一次就要看到
--     「夹不存在」这种中间态。

PRAGMA foreign_keys = OFF;

BEGIN;

-- ============================================================
-- 1. 重建 favorite_folders（加 target_kind，改默认夹唯一性）
-- ============================================================

CREATE TABLE favorite_folders_new (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name        TEXT    NOT NULL CHECK (trim(name) <> '' AND length(name) <= 40),
  -- 这个夹装哪一类东西。夹内只放同类收藏，跨类型混装会让「取消收藏」的语义变得不可说。
  target_kind TEXT    NOT NULL DEFAULT 'plugin' CHECK (target_kind IN ('plugin', 'pack', 'post')),
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at  INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at  INTEGER NOT NULL CHECK (updated_at >= 0),
  -- 同名只同一类内不允许：插件夹「常用」与帖子夹「常用」是两个夹，可以同名。
  UNIQUE (user_id, target_kind, name)
);

INSERT INTO favorite_folders_new (id, user_id, name, target_kind, is_default, created_at, updated_at)
SELECT id, user_id, name, 'plugin', is_default, created_at, updated_at
FROM favorite_folders;

-- 旧索引先删：索引名是库级唯一的，不删就建不了同名新索引。
DROP INDEX IF EXISTS uq_favorite_folders_default;

DROP TABLE favorite_folders;

ALTER TABLE favorite_folders_new RENAME TO favorite_folders;

CREATE UNIQUE INDEX uq_favorite_folders_default
  ON favorite_folders(user_id, target_kind) WHERE is_default = 1;

-- ============================================================
-- 2. 两类新收藏（帖子 / 整合包）
-- ============================================================

-- 整合包收藏：从 plugin_pack_favorites 迁入，从此读写这张表。
-- 一个包在一位用户下只能在一个夹里（主键 user_id + pack_id），换夹 = 更新 folder_id。
CREATE TABLE pack_favorites (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  pack_id    TEXT    NOT NULL REFERENCES plugin_packs(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  folder_id  TEXT    NOT NULL REFERENCES favorite_folders(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, pack_id)
);

CREATE INDEX idx_pack_favorites_by_folder ON pack_favorites(folder_id, created_at DESC, pack_id);
CREATE INDEX idx_pack_favorites_by_pack ON pack_favorites(pack_id);

-- 帖子收藏：帖子是软删的，所以这里会留下指向 deleted 帖子的行 —— 那是刻意的，
-- 收藏页要能显示「该帖已被删除」而不是让它凭空消失。
CREATE TABLE post_favorites (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  post_id    TEXT    NOT NULL REFERENCES forum_posts(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  folder_id  TEXT    NOT NULL REFERENCES favorite_folders(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX idx_post_favorites_by_folder ON post_favorites(folder_id, created_at DESC, post_id);
CREATE INDEX idx_post_favorites_by_post ON post_favorites(post_id);

-- ============================================================
-- 3. 老数据迁移：整合包收藏 → pack_favorites
-- ============================================================

-- 每个收藏过整合包的用户补一个整合包默认夹（与插件默认夹同名、互不相干）。
INSERT INTO favorite_folders (id, user_id, name, target_kind, is_default, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  u.id, '默认收藏夹', 'pack', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users u
WHERE EXISTS (SELECT 1 FROM plugin_pack_favorites f WHERE f.user_id = u.id)
  AND NOT EXISTS (
    SELECT 1 FROM favorite_folders ff WHERE ff.user_id = u.id AND ff.target_kind = 'pack' AND ff.is_default = 1
  );

INSERT INTO pack_favorites (user_id, pack_id, folder_id, created_at)
SELECT f.user_id, f.pack_id, ff.id, f.created_at
FROM plugin_pack_favorites f
JOIN favorite_folders ff
  ON ff.user_id = f.user_id AND ff.target_kind = 'pack' AND ff.is_default = 1
WHERE NOT EXISTS (
  SELECT 1 FROM pack_favorites pf WHERE pf.user_id = f.user_id AND pf.pack_id = f.pack_id
);

COMMIT;

PRAGMA foreign_keys = ON;

PRAGMA foreign_key_check;
