-- 0040_user_roles.sql
--
-- 用户身份体系：测评员 / 开发者（设计见 docs/项目规划/设计-用户身份体系.md）。
--
-- 为什么另开一张表而不是给 users 加布尔列：
--   users.role 是**权限底座**（user / admin，决定能否进后台、能否审内容），
--   而测评员 / 开发者是**叠加在普通用户之上的能力标记**，两者语义不同，
--   混进同一个 CHECK 会让「管理员是不是测评员」这种问题没有答案。
--   用表存身份，以后加「企业」只需扩 CHECK 取值，不必开列改表。
--
-- 为什么编号是 0040：
--   0037/0038 被讨论区 PR 占用、0039 被收藏重构占用，都还未合入 main。
--   本功能与它们无依赖，用 0040 可以让三个 PR 任意顺序合并（0027 已有跳号先例）。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. 身份
-- ============================================================

-- 一个用户可同时持有多种身份（使用者裁定：测评员与开发者可并存，各自申请）。
-- 同类身份只有一条记录：撤销后再申请复用同一行，历史留在 role_applications 里。
CREATE TABLE user_roles (
  id             TEXT    PRIMARY KEY,
  user_id        TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  role_type      TEXT    NOT NULL CHECK (role_type IN ('reviewer', 'developer')),
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- 授予来源。管理员直接授予时 application_id 为空（当前无此通道，留字段为将来）
  application_id TEXT,
  granted_by     TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  granted_at     INTEGER NOT NULL CHECK (granted_at >= 0),
  revoked_by     TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revoked_at     INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  -- 撤销态必须留下「谁在什么时候撤的」，与帖子软删同一口径
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_by IS NOT NULL)),
  UNIQUE (user_id, role_type)
);
CREATE INDEX idx_user_roles_by_user ON user_roles(user_id, role_type);

-- ============================================================
-- 2. 身份申请
-- ============================================================

-- evidence 存**申请那一刻的资格快照**，不让审核时现算：
-- 用户申请后又删了一篇评测的话，现算会让管理员看到与申请人不同的数字，容易起争议；
-- 快照也让「凭什么批的」有据可查。
CREATE TABLE role_applications (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  role_type    TEXT    NOT NULL CHECK (role_type IN ('reviewer', 'developer')),
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  evidence     TEXT    CHECK (evidence IS NULL OR json_valid(evidence)),
  note         TEXT    CHECK (note IS NULL OR length(note) <= 500),
  reviewer_id  TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  review_note  TEXT    CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  reviewed_at  INTEGER CHECK (reviewed_at IS NULL OR reviewed_at >= 0),
  -- 审核结论必须留下审核人与时间
  CHECK ((status IN ('approved', 'rejected')) = (reviewed_at IS NOT NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (reviewer_id IS NOT NULL))
);
CREATE INDEX idx_role_applications_user ON role_applications(user_id, created_at DESC, id);
CREATE INDEX idx_role_applications_queue ON role_applications(status, created_at, id);

-- 同一用户 + 同一身份，同时只允许一条待审申请。
-- 「被驳回后能再申请」靠状态是 rejected 来放行，不需要额外去重键。
CREATE UNIQUE INDEX uq_role_applications_pending
  ON role_applications(user_id, role_type) WHERE status = 'pending';

-- ============================================================
-- 3. 插件归属（认领）
-- ============================================================

-- plugins 表原本没有作者字段（只有 repository_id + plugin_path），
-- 作者只能从 repositories.owner_login 反推。因此归属分两条路：
--   * github_match：用户 external_identities.provider_username 与仓库 owner_login
--     相同（忽略大小写），证据链已由 OAuth 绑定，自动 verified，无需人工审；
--   * claimed：仓库 owner 是组织（如 dsh-org/x）或用户是协作者而非 owner，
--     自动匹配永远失败，只能主动声明 + 人工核实。
CREATE TABLE plugin_ownerships (
  id           TEXT    PRIMARY KEY,
  plugin_id    TEXT    NOT NULL REFERENCES plugins(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  source       TEXT    NOT NULL CHECK (source IN ('github_match', 'claimed')),
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'verified', 'rejected')),
  claimed_note TEXT    CHECK (claimed_note IS NULL OR length(claimed_note) <= 500),
  reviewer_id  TEXT    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewed_at  INTEGER CHECK (reviewed_at IS NULL OR reviewed_at >= 0),
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  -- github_match 天然是已验证的；claimed 必须经人审才能到 verified。
  -- 这条约束把「自动匹配绕过审核」和「认领未经审核」两种情况都挡在库外。
  CHECK (source = 'github_match' OR status <> 'verified' OR reviewed_at IS NOT NULL),
  -- 只约束一件真正要守的事：**待审态不能带审核痕迹**。
  --
  -- 实测踩过两个坑，都记在这里，免得后来人再绕一遍：
  --   * 坑一：(status='verified' AND source='claimed') = (reviewer_id IS NOT NULL)
  --     驳回时左边 false、右边 true，恒假 —— 驳回这条路写不进去。
  --   * 坑二：「不是待审态就必须有审核人」也是错的：github_match 自动通过的
  --     行是 verified 且没有审核人，那是合法状态（没人审，因为不需要审）。
  -- 结论：审核人只对「claimed 的 verified」与「rejected」是必须的，这条牵动分支太多，
  -- 改由服务层保证（reviewClaim 一律写 reviewer_id），库里只守最硬的一条：
  -- **待审态不许带审核时间**。
  --
  -- ⚠️ 不要写成 (status='pending') = (reviewed_at IS NULL)：SQLite 里
  -- 「false = true」为 false，会把「verified 且无审核时间」的自动匹配行一起拦掉。
  -- 必须写成蕴含式，只约束一个方向。
  CHECK (status <> 'pending' OR reviewed_at IS NULL)
  UNIQUE (plugin_id, user_id)
);
CREATE INDEX idx_plugin_ownerships_user ON plugin_ownerships(user_id, status, created_at DESC);
CREATE INDEX idx_plugin_ownerships_plugin ON plugin_ownerships(plugin_id);
CREATE INDEX idx_plugin_ownerships_queue ON plugin_ownerships(status, created_at, id);

-- 一个插件只能有一个 verified 的归属人：否则「我的插件」会出现两个人，
-- 开发者身份的门槛就说不清了。待审与驳回不限（可能有多人同时认领，由管理员裁定）。
CREATE UNIQUE INDEX uq_plugin_ownerships_verified
  ON plugin_ownerships(plugin_id) WHERE status = 'verified';
