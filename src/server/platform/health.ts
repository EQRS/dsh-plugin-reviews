/**
 * 健康报告（容器 HEALTHCHECK 与运维诊断用）。
 *
 * 定位：回答"这个进程还能不能用、库还在不在正常工作"。
 * 它**不做业务统计**（不数用户/评测/评论），原因有两个：
 *   1) 健康检查会被高频调用，不该成为负担；
 *   2) 这个端点可能是公网可达的，业务数字不该顺手泄露。
 * 需要业务全貌时走 `scripts/diagnose.mjs`（直连库，且只有运维能跑）。
 *
 * 库结构那部分**复用** `selfCheck`，不另写一套判断 —— 两处判断不一致比没有判断更糟。
 */

import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqliteDatabase } from './db';
import { selfCheck } from './migrate';
import { WORKER_HEARTBEAT_NAME, heartbeatState } from './heartbeat';
import type { HeartbeatState } from './heartbeat';

export interface HealthCheck {
  name: string;
  ok: boolean;
  /** 给人看的短说明（不含凭据、不含业务量）。 */
  detail?: string;
}

export type HealthStatus = 'ok' | 'degraded' | 'fail';

export interface HealthReport {
  status: HealthStatus;
  checked_at: number;
  schema_version: string | null;
  checks: HealthCheck[];
  worker: { state: HeartbeatState; age_ms: number | null };
  disk: { free_mb: number | null; ok: boolean | null };
}

export interface HealthOptions {
  now: number;
  /** 库文件路径；给了才检查磁盘余量（不传 = 跳过该项，不是"通过"）。 */
  dbFile?: string;
  /** 是否把 worker 心跳算进结论（web 的存活检查不该因为 worker 挂了而失败）。 */
  requireWorker?: boolean;
  /** 磁盘余量下限（MB），默认 200。 */
  minFreeMb?: number;
  staleMs?: number;
  deadMs?: number;
}

const DEFAULT_MIN_FREE_MB = 200;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildHealthReport(db: SqliteDatabase, options: HealthOptions): HealthReport {
  const checks: HealthCheck[] = [];
  let status: HealthStatus = 'ok';
  let schemaVersion: string | null = null;

  // —— 1. 库：能不能查、结构对不对（复用 selfCheck）
  try {
    const info = selfCheck(db);
    schemaVersion = info.schemaVersion;
    checks.push({ name: 'db.readable', ok: true });
    checks.push({
      name: 'db.foreign_keys',
      ok: info.foreignKeys,
      detail: info.foreignKeys ? '已启用' : '未启用（外键约束不会生效）',
    });
    checks.push({
      name: 'db.journal_mode',
      ok: info.journalMode === 'wal',
      detail: info.journalMode,
    });
    checks.push({
      name: 'db.required_tables',
      ok: info.missingTables.length === 0,
      detail: info.missingTables.length === 0 ? '齐全' : `缺少：${info.missingTables.join(', ')}`,
    });
    // 外键没开、业务表缺失属**结构性故障**：进程看起来活着，但业务已经不成立了。
    if (!info.foreignKeys || info.missingTables.length > 0) status = 'fail';
  } catch (e) {
    status = 'fail';
    checks.push({ name: 'db.readable', ok: false, detail: messageOf(e) });
  }

  // —— 2. 磁盘：库所在分区还有多少余量（写不进去时一切"正常"都是假的）
  let disk: HealthReport['disk'] = { free_mb: null, ok: null };
  if (options.dbFile) {
    try {
      const st = statfsSync(dirname(options.dbFile));
      const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
      const ok = freeMb >= (options.minFreeMb ?? DEFAULT_MIN_FREE_MB);
      disk = { free_mb: freeMb, ok };
      checks.push({ name: 'disk.free', ok, detail: `${freeMb} MB` });
      if (!ok) status = 'fail';
    } catch (e) {
      disk = { free_mb: null, ok: false };
      checks.push({ name: 'disk.free', ok: false, detail: `读不到：${messageOf(e)}` });
      status = 'fail';
    }
  }

  // —— 3. worker 心跳：默认**只报告不影响结论**（见 requireWorker 注释）
  let worker: HealthReport['worker'] = { state: 'missing', age_ms: null };
  try {
    const record = db
      .prepare('SELECT name, started_at, beat_at, detail FROM runtime_heartbeats WHERE name = ?')
      .get(WORKER_HEARTBEAT_NAME) as
      | { name: string; started_at: number; beat_at: number; detail: string | null }
      | undefined;
    const verdict = heartbeatState(
      record ? { name: record.name, startedAt: record.started_at, beatAt: record.beat_at, detail: record.detail } : null,
      options.now,
      { staleMs: options.staleMs, deadMs: options.deadMs },
    );
    worker = { state: verdict.state, age_ms: verdict.ageMs };
    checks.push({
      name: 'worker.heartbeat',
      ok: verdict.state === 'ok',
      detail:
        verdict.state === 'missing'
          ? '从没写过心跳（worker 没跑过？）'
          : `上次心跳在 ${Math.round((verdict.ageMs ?? 0) / 1000)} 秒前`,
    });
    if (options.requireWorker && verdict.state !== 'ok') {
      // 调用方**显式**问了 worker（`?worker=1`），那答案就该是 503：
      // "worker 没在正常心跳"这件事必须能让 `curl -f` / 监控直接失败。
      // 默认不传这个开关时，worker 状态只报告、不影响结论 —— 否则 web 的存活检查
      // 会因为 worker 挂掉而被编排器重启，那是错的。
      status = 'fail';
    }
  } catch (e) {
    // 心跳表都没有 = 迁移没跑到 0004，属未完成部署；但这一项本身不判死。
    checks.push({ name: 'worker.heartbeat', ok: false, detail: `读不到心跳表：${messageOf(e)}` });
  }

  return {
    status,
    checked_at: Math.trunc(options.now),
    schema_version: schemaVersion,
    checks,
    worker,
    disk,
  };
}

/** HTTP 状态码：只有 fail 才 503（degraded 仍返回 200，让编排不要乱重启）。 */
export function statusForHealth(report: HealthReport): number {
  return report.status === 'fail' ? 503 : 200;
}
