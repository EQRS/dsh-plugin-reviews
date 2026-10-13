-- 0004_runtime_heartbeats.sql
-- 为「容器与运维要能判断进程是不是已经不吭声地死了」补一张最小运行时表：
--   worker 每轮循环与固定间隔各写一次心跳；健康检查、容器 HEALTHCHECK 与诊断脚本读它。
--
-- 为什么单开一张表、不复用现有表：现有表都有业务语义（任务、提交、操作记录、会话），
-- 心跳属于**运行时状态**，混进业务表会污染业务查询，也会让人误以为它是业务事实。
--
-- 约束风格与 0001/0002/0003 一致：TEXT/INTEGER/JSON 文本，CHECK 明确，
-- 时间一律 UTC 毫秒；这张表没有任何外键（它不属于任何业务对象）。

PRAGMA foreign_keys = ON;

CREATE TABLE runtime_heartbeats (
  name        TEXT    PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 64),
  -- 进程启动时刻：只在第一次写入时落，后续心跳不覆盖（用于算"这一轮活了多久"）。
  started_at  INTEGER NOT NULL CHECK (started_at >= 0),
  -- 最后一次心跳时刻：判断"现在还在不在"。
  beat_at     INTEGER NOT NULL CHECK (beat_at >= 0),
  -- 可选上下文（例如正在处理的并发数），必须是合法 JSON 文本。
  detail      TEXT    CHECK (detail IS NULL OR json_valid(detail))
);
