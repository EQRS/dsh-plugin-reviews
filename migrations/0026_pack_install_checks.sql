-- 0026_pack_install_checks.sql
--
-- 整合包版本的安装资料核验记录（架构 §36.2）。
-- 当前记录「结构核验」：结构化 install_target 是否齐全；网络核验（npm/GitHub 可达性）后续接。

CREATE TABLE plugin_install_checks (
  id               TEXT    PRIMARY KEY,
  release_item_id  TEXT    NOT NULL REFERENCES plugin_pack_release_items(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  target_fingerprint TEXT  NOT NULL CHECK (trim(target_fingerprint) <> ''),
  check_sequence   INTEGER NOT NULL CHECK (check_sequence > 0),
  result           TEXT    NOT NULL CHECK (result IN ('structural_ok', 'missing')),
  reason           TEXT,
  requested_at     INTEGER NOT NULL CHECK (requested_at >= 0),
  completed_at     INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  UNIQUE (release_item_id, check_sequence)
);

CREATE INDEX idx_install_checks_by_item ON plugin_install_checks(release_item_id, check_sequence DESC);
