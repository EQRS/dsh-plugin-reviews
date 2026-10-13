-- 0006_rate_limiter.sql
-- 请求频控的存储表（`参数与管理规则.md` 第 3 节）。
--
-- ⚠️ 这张表的 DDL 是**照抄 rate-limiter-flexible 自己建的**（11.2.2，
-- `lib/RateLimiterSQLite.js` 的 `_getCreateTableSQL()`），实测 dump 出来的原文是：
--
--     CREATE TABLE rate_limiter_flexible (
--       key TEXT PRIMARY KEY,
--       points INTEGER NOT NULL DEFAULT 0,
--       expire INTEGER
--     )
--
-- 为什么要抄过来而不是让库自己建：本项目的纪律是"**权威结构是 migrations/*.sql**"，
-- 库运行时偷偷建表会让结构脱离迁移记录（备份、自检、回滚都看不到它）。
-- 抄过来之后 limiter 用 `tableCreated: true` 构造，**不再自己建表**。
-- 升级库里这个库版本时，要重新确认 DDL 是否变了（tests/rate-limit.test.ts 会咬住列名）。
--
-- 列语义：
--   * key    = 库内部的 rlflx 前缀 + 我们的动作键（形如 `rlflx:comment_change:<userId>`）
--   * points = 当前窗口内已消耗的点数
--   * expire = 窗口到期时刻（**UTC 毫秒**，绝对时间；为空表示永不过期）

PRAGMA foreign_keys = ON;

CREATE TABLE rate_limiter_flexible (
  key TEXT PRIMARY KEY,
  points INTEGER NOT NULL DEFAULT 0,
  expire INTEGER
);

-- 清理过期行时要扫 expire（`clearExpiredByTimeout` 或我们自己清都用得上）。
CREATE INDEX idx_rate_limiter_expire ON rate_limiter_flexible (expire);
