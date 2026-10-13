/**
 * 运行时心跳（迁移 0004）。
 *
 * 解决的问题：worker 是独立进程，**静默死亡**（OOM、库锁死、被 SIGKILL）
 * 在业务上表现为"内容再也不公开了"，而日志里可能一个字都没有 ——
 * 这在容器里尤其难发现，因为进程退出会被 restart 策略悄悄拉起、或者干脆没起来。
 *
 * 做法：worker 每轮循环 + 固定间隔各写一次心跳；健康检查与容器 HEALTHCHECK 读它，
 * `age` 超过阈值即判定为 stale/dead。
 *
 * 边界：这里只读写 `runtime_heartbeats` 一张表，不做任何业务表扫描。
 */

import type { SqliteDatabase } from './db';

/** worker 的心跳名。多进程并存时可按名字区分（本切片只有一种）。 */
export const WORKER_HEARTBEAT_NAME = 'worker';

/** 超过这个年龄算"卡住了"（降级）：默认 30 秒。 */
export const WORKER_STALE_MS = 30_000;

/** 超过这个年龄算"死了"：默认 120 秒。 */
export const WORKER_DEAD_MS = 120_000;

/** 心跳写入间隔（worker 用；要显著小于 STALE）。 */
export const WORKER_BEAT_INTERVAL_MS = 5_000;

const MAX_NAME_LENGTH = 64;

export interface HeartbeatRecord {
  name: string;
  startedAt: number;
  beatAt: number;
  detail: string | null;
}

/** 心跳状态：ok=正常 / stale=卡住 / dead=疑似已死 / missing=从未写过。 */
export type HeartbeatState = 'ok' | 'stale' | 'dead' | 'missing';

function assertName(name: string): void {
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    throw new Error(`心跳名长度必须在 1..${MAX_NAME_LENGTH} 之间：${name.length}`);
  }
}

/**
 * 写一次心跳。**幂等**：同一进程重复调用只更新 `beat_at` 与 `detail`，
 * `started_at` 保持首次写入的值（否则"活了多久"会被每次心跳重置成 0）。
 */
export function beat(
  db: SqliteDatabase,
  name: string,
  now: number,
  detail?: Record<string, unknown> | null,
): void {
  assertName(name);
  if (!Number.isFinite(now) || now < 0) throw new Error(`心跳时间必须是 UTC 毫秒：${now}`);
  const json = detail === undefined || detail === null ? null : JSON.stringify(detail);
  db.prepare(
    `INSERT INTO runtime_heartbeats (name, started_at, beat_at, detail)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       beat_at = excluded.beat_at,
       detail  = excluded.detail`,
  ).run(name, Math.trunc(now), Math.trunc(now), json);
}

/** 读一条心跳；没有则返回 null（"从没写过"和"写过但很旧"必须能区分）。 */
export function readHeartbeat(db: SqliteDatabase, name: string): HeartbeatRecord | null {
  assertName(name);
  const row = db
    .prepare('SELECT name, started_at, beat_at, detail FROM runtime_heartbeats WHERE name = ?')
    .get(name) as { name: string; started_at: number; beat_at: number; detail: string | null } | undefined;
  if (!row) return null;
  return { name: row.name, startedAt: row.started_at, beatAt: row.beat_at, detail: row.detail };
}

/** 心跳年龄（毫秒）。时钟回拨时不返回负数。 */
export function heartbeatAgeMs(record: HeartbeatRecord | null, now: number): number | null {
  if (!record) return null;
  return Math.max(0, Math.trunc(now) - record.beatAt);
}

/** 由年龄判定状态。**纯函数**，便于固定数字测试。 */
export function heartbeatState(
  record: HeartbeatRecord | null,
  now: number,
  thresholds: { staleMs?: number; deadMs?: number } = {},
): { state: HeartbeatState; ageMs: number | null } {
  const staleMs = thresholds.staleMs ?? WORKER_STALE_MS;
  const deadMs = thresholds.deadMs ?? WORKER_DEAD_MS;
  const ageMs = heartbeatAgeMs(record, now);
  if (ageMs === null) return { state: 'missing', ageMs: null };
  if (ageMs >= deadMs) return { state: 'dead', ageMs };
  if (ageMs >= staleMs) return { state: 'stale', ageMs };
  return { state: 'ok', ageMs };
}

/**
 * 装配一个"心跳写入器"：`start()` 立刻写一次并按间隔续写，返回停止函数。
 * `unref()` 让心跳定时器**不阻止进程退出**（否则 worker 收到 SIGTERM 后停不下来）。
 */
export function startHeartbeat(
  db: SqliteDatabase,
  name: string,
  options: {
    now?: () => number;
    intervalMs?: number;
    detail?: () => Record<string, unknown> | null;
  } = {},
): { stop: () => void; beatNow: () => void } {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? WORKER_BEAT_INTERVAL_MS;
  const beatNow = () => {
    beat(db, name, now(), options.detail ? options.detail() : null);
  };
  beatNow();
  const timer = setInterval(beatNow, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), beatNow };
}
