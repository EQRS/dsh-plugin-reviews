-- 0003_auth_media.sql
-- 为「真用户能走通」补齐两块持久结构：
--   1) GitHub OAuth 短期登录挑战（架构第 11 节、依赖与部署第 5 节）
--   2) 图片附件：附件身份 / 文件版本 / 本地落盘 / 与草稿及修订的引用关系
--      （数据库模型第 6 节的本地保底子集；多存储源与副本表不在本切片）
--
-- 约束风格与 0001/0002 一致：ID=UUIDv7 TEXT，TS=UTC 毫秒 INTEGER，B=0/1，
-- 枚举走明确 CHECK，外键默认 RESTRICT，跨行规则用受限触发器。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. GitHub OAuth 短期挑战
-- ============================================================

-- 本站设计的短期上下文表，不是任何认证库强制的表（架构第 109 节）。
-- 只存摘要，不存 state / 浏览器绑定的原值；code_verifier 需要原值才能参与 PKCE，
-- 因此以加密信封保存（本切片存 JSON 信封；密钥由部署配置提供，未配置时不接受生产登录）。
CREATE TABLE oauth_login_challenges (
  id                      TEXT    PRIMARY KEY,
  provider                TEXT    NOT NULL CHECK (provider IN ('github')),
  state_digest            TEXT    NOT NULL CHECK (length(state_digest) = 64),
  browser_binding_digest  TEXT    NOT NULL CHECK (length(browser_binding_digest) = 64),
  code_verifier_envelope  TEXT    NOT NULL CHECK (json_valid(code_verifier_envelope)),
  return_path             TEXT    NOT NULL,
  created_at              INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at              INTEGER NOT NULL CHECK (expires_at >= 0),
  consumed_at             INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),

  UNIQUE (state_digest),
  -- return_path 只允许站内相对路径：不接受绝对 URL 或协议相对地址，
  -- 否则登录回跳会变成开放重定向。
  CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%'),
  CHECK (expires_at > created_at),
  -- 非空 consumed 必须落在有效期内
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at))
);
CREATE INDEX idx_oauth_challenges_expires ON oauth_login_challenges(expires_at, id);

-- ============================================================
-- 2. 图片附件
-- ============================================================

-- 附件身份：一次"用户想传一张图"的稳定记录，先有身份再有字节。
CREATE TABLE attachments (
  id                TEXT    PRIMARY KEY,
  uploaded_by       TEXT    NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  original_filename TEXT    NOT NULL CHECK (trim(original_filename) <> ''),
  -- pending: 已登记未收到完整字节；processing: 收到后正在鉴图/压缩；
  -- ready: 必要文件已就绪且本地落盘核对通过；failed: 明确失败，原因在 last_error_code
  processing_state  TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (processing_state IN ('pending','processing','ready','failed')),
  last_error_code   TEXT,
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  ready_at          INTEGER CHECK (ready_at IS NULL OR ready_at >= 0),

  UNIQUE (id, uploaded_by),
  -- ready 必须带就绪时间；未就绪不得带
  CHECK ((processing_state = 'ready') = (ready_at IS NOT NULL)),
  -- failed 必须有原因；其他状态不伪装成失败原因
  CHECK ((processing_state = 'failed') = (last_error_code IS NOT NULL))
);
CREATE INDEX idx_attachments_uploader ON attachments(uploaded_by, created_at, id);
CREATE INDEX idx_attachments_state ON attachments(processing_state, id);

-- 文件版本：同一附件可有多个尺寸版本（原图 / 展示图），版本键不可原地改写。
CREATE TABLE attachment_files (
  id               TEXT    PRIMARY KEY,
  attachment_id    TEXT    NOT NULL REFERENCES attachments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  variant_key      TEXT    NOT NULL CHECK (trim(variant_key) <> ''),
  variant_role     TEXT    NOT NULL CHECK (variant_role IN ('original','display')),
  mime_type        TEXT    NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  byte_size        INTEGER NOT NULL CHECK (byte_size > 0),
  width            INTEGER NOT NULL CHECK (width > 0),
  height           INTEGER NOT NULL CHECK (height > 0),
  -- 本切片固定 sha256；哈希为 64 位小写十六进制
  hash_algorithm   TEXT    NOT NULL DEFAULT 'sha256' CHECK (hash_algorithm = 'sha256'),
  content_hash     TEXT    NOT NULL CHECK (content_hash GLOB '[0-9a-f]*' AND length(content_hash) = 64),
  processing_state TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (processing_state IN ('pending','ready','failed')),
  created_at       INTEGER NOT NULL CHECK (created_at >= 0),

  UNIQUE (attachment_id, variant_key),
  UNIQUE (attachment_id, variant_role)
);
CREATE INDEX idx_attachment_files_attachment ON attachment_files(attachment_id, variant_key);

-- 本地保底落盘记录：一个文件版本对应一份实际载荷。
-- storage_key 由**服务端生成**（形如 attachments/<attachmentId>/<variantKey>），
-- 绝不由用户提供的文件名拼成；外键保证它属于真实文件版本。
CREATE TABLE attachment_blobs (
  id            TEXT    PRIMARY KEY,
  file_id       TEXT    NOT NULL REFERENCES attachment_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  storage_key   TEXT    NOT NULL CHECK (trim(storage_key) <> ''),
  byte_size     INTEGER NOT NULL CHECK (byte_size > 0),
  content_hash  TEXT    NOT NULL CHECK (content_hash GLOB '[0-9a-f]*' AND length(content_hash) = 64),
  verified_at   INTEGER NOT NULL CHECK (verified_at >= 0),
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),

  UNIQUE (storage_key),
  UNIQUE (file_id)
);

-- 草稿引用：作者在编辑期插入的、或作为候选封面的文件。
CREATE TABLE draft_attachment_links (
  draft_id  TEXT NOT NULL REFERENCES content_drafts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  file_id   TEXT NOT NULL REFERENCES attachment_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  usage     TEXT NOT NULL CHECK (usage IN ('body','cover')),

  PRIMARY KEY (draft_id, file_id, usage)
);
CREATE INDEX idx_draft_attachment_links_file ON draft_attachment_links(file_id, draft_id);

-- 修订引用：提交快照固定下来的文件使用关系（历史不可改写）。
CREATE TABLE review_revision_attachment_links (
  review_revision_id TEXT NOT NULL REFERENCES review_revisions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  file_id            TEXT NOT NULL REFERENCES attachment_files(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  usage              TEXT NOT NULL CHECK (usage IN ('body','cover')),

  PRIMARY KEY (review_revision_id, file_id, usage)
);
CREATE INDEX idx_review_revision_attachment_links_file ON review_revision_attachment_links(file_id, review_revision_id);
-- 一篇修订至多一个封面
CREATE UNIQUE INDEX uq_review_revision_cover
  ON review_revision_attachment_links(review_revision_id) WHERE usage = 'cover';

-- ============================================================
-- 3. 跨行规则（CHECK 表达不了的部分）
-- ============================================================

-- 只有 uploaded_by 本人能在其草稿里引用该文件；
-- 防止 A 把 B 的附件挂到自己的草稿上（越权引用）。
CREATE TRIGGER trg_draft_attachment_owner_insert
BEFORE INSERT ON draft_attachment_links
BEGIN
  SELECT RAISE(ABORT, 'draft_attachment_links: 只能引用本人上传的附件')
  WHERE NOT EXISTS (
    SELECT 1
      FROM content_drafts d
      JOIN attachments a ON a.id = (SELECT attachment_id FROM attachment_files WHERE id = NEW.file_id)
     WHERE d.id = NEW.draft_id AND a.uploaded_by = d.owner_id
  );
END;

-- 引用关系创建后不可改写（历史固定证据）。
CREATE TRIGGER trg_review_revision_attachment_links_immutable
BEFORE UPDATE ON review_revision_attachment_links
BEGIN
  SELECT RAISE(ABORT, 'review_revision_attachment_links: 引用关系不可改写');
END;

-- 只有正文引用的文件才允许是 display 变体（原图不做公开读取）——
-- 这条由服务层在读取时按 variant_role 过滤，数据库层只保证角色合法。
