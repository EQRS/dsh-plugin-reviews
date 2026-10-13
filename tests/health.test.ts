/**
 * 健康检查与运行时心跳（迁移 0004）。
 *
 * 纪律（与全仓一致）：
 *  - 用**真实临时文件 + 真实迁移**，不用 `:memory:`；
 *  - 断言必须能在实现被破坏时变红：把 `beat` 的 upsert 改成只 INSERT → 重复心跳用例失败；
 *    把 `heartbeatState` 的阈值比较改成 `>` → 边界用例失败；
 *    把路由的 detail 门禁去掉 → 公网不带 checks 的用例失败。
 */

import { describe, expect, it, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { createTestDb, type TestDb } from './support/db';
import {
  WORKER_DEAD_MS,
  WORKER_HEARTBEAT_NAME,
  WORKER_STALE_MS,
  beat,
  beginRun,
  heartbeatAgeMs,
  heartbeatState,
  readHeartbeat,
  startHeartbeat,
} from '../src/server/platform/heartbeat';
import { buildHealthReport, statusForHealth } from '../src/server/platform/health';
import { selfCheck } from '../src/server/platform/migrate';
import { closeDb } from '../src/server/platform/db';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): TestDb {
  ctx = createTestDb();
  return ctx;
}

/**
 * 最新迁移文件名：从 `migrations/` **现取**，不硬写。
 * 硬写版本号的结果是"每加一个迁移就要改两处测试"，改一次忘一次 —— 那是噪音不是覆盖；
 * 现取仍是有意义的断言：它咬住"健康检查报的版本 == 库里实际应用的最新迁移"。
 */
const LATEST_MIGRATION = readdirSync('migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .at(-1) as string;

describe('运行时心跳（迁移 0004）', () => {
  it('迁移 0004 真的进库了：自检要求表齐全，且心跳表可写可读', () => {
    const { db } = setup();
    const check = selfCheck(db);
    expect(check.missingTables).toEqual([]);

    const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(existing).toContain('runtime_heartbeats');

    beat(db, WORKER_HEARTBEAT_NAME, 1_000, { pid: 42 });
    const record = readHeartbeat(db, WORKER_HEARTBEAT_NAME);
    expect(record).not.toBeNull();
    expect(record?.beatAt).toBe(1_000);
    expect(record?.startedAt).toBe(1_000);
    expect(JSON.parse(record?.detail ?? '{}')).toEqual({ pid: 42 });
  });

  it('重复心跳只推进 beat_at，**不重置** started_at（否则"活了多久"每次归零）', () => {
    const { db } = setup();
    beat(db, WORKER_HEARTBEAT_NAME, 1_000, null);
    beat(db, WORKER_HEARTBEAT_NAME, 9_000, { pid: 43 });
    const record = readHeartbeat(db, WORKER_HEARTBEAT_NAME);
    expect(record?.startedAt).toBe(1_000);
    expect(record?.beatAt).toBe(9_000);
    expect(JSON.parse(record?.detail ?? '{}')).toEqual({ pid: 43 });
  });

  it('没有心跳时读回 null（"从没写过"必须能和"写过但很旧"区分开）', () => {
    const { db } = setup();
    expect(readHeartbeat(db, WORKER_HEARTBEAT_NAME)).toBeNull();
  });

  it('**新进程的第一次写入（beginRun）重置 started_at**：重启不能被误读成"一直活到现在"', () => {
    const { db } = setup();
    // 上一轮跑了很久
    beat(db, WORKER_HEARTBEAT_NAME, 1_000, { pid: 42 });
    beat(db, WORKER_HEARTBEAT_NAME, 100_000, { pid: 42 });
    expect(readHeartbeat(db, WORKER_HEARTBEAT_NAME)?.startedAt).toBe(1_000);

    // 进程重启：第一笔必须是 beginRun，把"本轮开始时间"拉回现在
    beginRun(db, WORKER_HEARTBEAT_NAME, 200_000, { pid: 99 });
    const afterRestart = readHeartbeat(db, WORKER_HEARTBEAT_NAME);
    expect(afterRestart?.startedAt).toBe(200_000);
    expect(afterRestart?.beatAt).toBe(200_000);

    // 之后同进程的心跳仍然保留 started_at（两者语义不能混）
    beat(db, WORKER_HEARTBEAT_NAME, 205_000, { pid: 99 });
    expect(readHeartbeat(db, WORKER_HEARTBEAT_NAME)?.startedAt).toBe(200_000);
    expect(readHeartbeat(db, WORKER_HEARTBEAT_NAME)?.beatAt).toBe(205_000);
  });

  it('心跳名长度有界，超长直接拒绝，不写脏数据', () => {
    const { db } = setup();
    expect(() => beat(db, 'x'.repeat(65), 1_000)).toThrow();
    expect(db.prepare('SELECT count(*) AS c FROM runtime_heartbeats').get()).toEqual({ c: 0 });
  });

  it('startHeartbeat 立刻写一次，并按间隔续写；stop 之后不再写', () => {
    vi.useFakeTimers();
    try {
      const { db } = setup();
      let clock = 500_000;
      const hb = startHeartbeat(db, WORKER_HEARTBEAT_NAME, { now: () => clock, intervalMs: 5_000 });
      expect(readHeartbeat(db, WORKER_HEARTBEAT_NAME)?.beatAt).toBe(500_000);

      clock = 505_000;
      vi.advanceTimersByTime(5_000);
      expect(readHeartbeat(db, WORKER_HEARTBEAT_NAME)?.beatAt).toBe(505_000);

      hb.stop();
      clock = 999_000;
      vi.advanceTimersByTime(60_000);
      expect(readHeartbeat(db, WORKER_HEARTBEAT_NAME)?.beatAt).toBe(505_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('心跳状态判定（纯函数，固定数字）', () => {
  const record = (beatAt: number) => ({ name: WORKER_HEARTBEAT_NAME, startedAt: 0, beatAt, detail: null });

  it('没有记录 = missing（不是 ok，也不是 dead）', () => {
    expect(heartbeatState(null, 1_000)).toEqual({ state: 'missing', ageMs: null });
    expect(heartbeatAgeMs(null, 1_000)).toBeNull();
  });

  it('阈值边界：STALE-1 仍算 ok，正好 STALE 算 stale，正好 DEAD 算 dead', () => {
    const now = 1_000_000;
    expect(heartbeatState(record(now - (WORKER_STALE_MS - 1)), now).state).toBe('ok');
    expect(heartbeatState(record(now - WORKER_STALE_MS), now).state).toBe('stale');
    expect(heartbeatState(record(now - (WORKER_DEAD_MS - 1)), now).state).toBe('stale');
    expect(heartbeatState(record(now - WORKER_DEAD_MS), now).state).toBe('dead');
  });

  it('时钟回拨不会算出负年龄（负年龄会让所有阈值判断失去意义）', () => {
    expect(heartbeatAgeMs(record(2_000), 1_000)).toBe(0);
    expect(heartbeatState(record(2_000), 1_000).state).toBe('ok');
  });
});

describe('健康报告', () => {
  it('刚迁移完的库：结构项全绿、状态 ok、能看到 schema 版本与磁盘余量', () => {
    const { db, file } = setup();
    const report = buildHealthReport(db, { now: 1_000, dbFile: file });

    expect(report.status).toBe('ok');
    expect(statusForHealth(report)).toBe(200);
    expect(report.schema_version).toBe(LATEST_MIGRATION);
    expect(report.checks.map((c) => c.name)).toContain('db.readable');
    // 唯一允许"未 ok"的检查项就是 worker 心跳：它只报告，不改变结论（见 requireWorker 注释）。
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['worker.heartbeat']);
    expect(report.disk.ok).toBe(true);
    expect(report.disk.free_mb).toBeGreaterThan(0);
  });

  it('worker 从没写过心跳：默认不影响结论，但显式要求时判 fail（503）', () => {
    const { db, file } = setup();
    expect(buildHealthReport(db, { now: 1_000, dbFile: file }).worker.state).toBe('missing');

    const relaxed = buildHealthReport(db, { now: 1_000, dbFile: file });
    expect(relaxed.status).toBe('ok');

    const strict = buildHealthReport(db, { now: 1_000, dbFile: file, requireWorker: true });
    expect(strict.status).toBe('fail');
    expect(statusForHealth(strict)).toBe(503);
  });

  it('worker 心跳变旧：只报告年龄，不假装 ok', () => {
    const { db, file } = setup();
    beat(db, WORKER_HEARTBEAT_NAME, 1_000);
    const stale = buildHealthReport(db, { now: 1_000 + WORKER_STALE_MS, dbFile: file, requireWorker: true });
    expect(stale.worker.state).toBe('stale');
    expect(stale.worker.age_ms).toBe(WORKER_STALE_MS);
    expect(stale.status).toBe('fail');

    const fresh = buildHealthReport(db, { now: 1_000 + 10, dbFile: file, requireWorker: true });
    expect(fresh.worker.state).toBe('ok');
    expect(fresh.status).toBe('ok');
  });

  it('外键被关掉属结构性故障：状态 fail（进程还活着但业务已不成立）', () => {
    const { db, file } = setup();
    db.pragma('foreign_keys = OFF');
    const report = buildHealthReport(db, { now: 1_000, dbFile: file });
    expect(report.status).toBe('fail');
    expect(report.checks.find((c) => c.name === 'db.foreign_keys')?.ok).toBe(false);
  });
});

describe('GET /api/health（真调用路由）', () => {
  let routeCtx: TestDb;
  const TOKEN = 'health-token-for-tests-0123456789';

  beforeAll(async () => {
    // getDb() 是进程级单例：整个 describe 共用一个库，避免先缓存了别的路径。
    routeCtx = createTestDb();
    process.env.DSH_REVIEW_DB_PATH = routeCtx.file;
    process.env.DSH_REVIEW_HEALTH_TOKEN = TOKEN;
  });

  afterAll(() => {
    delete process.env.DSH_REVIEW_DB_PATH;
    delete process.env.DSH_REVIEW_HEALTH_TOKEN;
    // 先关掉 getDb() 那个进程级单例，否则 Windows 下临时库文件仍被占用、目录删不掉
    // （表现为文件级失败：EPERM ... dsh-review-test-xxxx，用例却全绿）。
    closeDb();
    routeCtx?.cleanup();
  });

  it('公网可见的响应只有状态与版本，**不含**逐项检查（不泄露内部结构）', async () => {
    const { GET } = await import('../src/app/api/health/route');
    const res = await GET(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.schema_version).toBe(LATEST_MIGRATION);
    expect(body.data.checks).toBeUndefined();
    expect(body.data.worker).toBeUndefined();
  });

  it('要详情必须带对令牌：没带 / 带错都拿不到 checks', async () => {
    const { GET } = await import('../src/app/api/health/route');

    const noToken = await GET(new Request('http://localhost/api/health?detail=1'));
    expect((await noToken.json()).data.checks).toBeUndefined();

    const wrongToken = await GET(
      new Request('http://localhost/api/health?detail=1', { headers: { 'x-health-token': 'nope' } }),
    );
    expect((await wrongToken.json()).data.checks).toBeUndefined();

    const ok = await GET(
      new Request('http://localhost/api/health?detail=1', { headers: { 'x-health-token': TOKEN } }),
    );
    const body = (await ok.json()) as { data: { checks: { name: string; ok: boolean }[] } };
    expect(Array.isArray(body.data.checks)).toBe(true);
    expect(body.data.checks.some((c) => c.name === 'db.required_tables')).toBe(true);
  });

  it('库结构坏掉时返回 503（编排器与 curl -f 都靠状态码判死）', async () => {
    const { GET } = await import('../src/app/api/health/route');
    routeCtx.db.exec('DROP TABLE runtime_heartbeats');
    try {
      const res = await GET(new Request('http://localhost/api/health'));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { data: { status: string } };
      expect(body.data.status).toBe('fail');
    } finally {
      // 还原，避免影响同文件后续用例（这条表由 REQUIRED_TABLES 兜着，不还原会连带失败）
      routeCtx.db.exec(
        `CREATE TABLE runtime_heartbeats (
           name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 64),
           started_at INTEGER NOT NULL CHECK (started_at >= 0),
           beat_at INTEGER NOT NULL CHECK (beat_at >= 0),
           detail TEXT CHECK (detail IS NULL OR json_valid(detail))
         )`,
      );
      expect(selfCheck(routeCtx.db).missingTables).toEqual([]);
    }
  });

  it('?worker=1 问的是 worker：它没心跳就 503', async () => {
    const { GET } = await import('../src/app/api/health/route');
    const res = await GET(new Request('http://localhost/api/health?worker=1'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { data: { status: string; worker?: unknown } };
    expect(body.data.status).toBe('fail');
  });
});
