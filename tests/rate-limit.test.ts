/**
 * 请求频控（迁移 0006 + `参数与管理规则.md` 第 3 节）。
 *
 * 这组测试盯的是四件"看起来对、实际错"的事：
 *  1. **并发不超发**：同一个用户同时打 20 个请求，绝不可能放过 over-limit 的那 15 个
 *     （自己写计数最容易写错的地方就是这里）；
 *  2. **过期即重置**：窗口过了必须重新给满额度，而不是永久封死；
 *  3. **重放退还**：幂等重放不另算一次提交（规格明文要求），退还后额度要回来；
 *  4. **表结构与库期望一致**：迁移 0006 的 DDL 是照抄 rate-limiter-flexible 的，
 *     升级那个库时要靠这条断言"咬"出来列名/表名变了。
 *
 * 全部用**真实临时库 + 真实迁移**（与全仓一致，不用 `:memory:`）。
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, insertUser, type TestDb } from './support/db';
import { isDomainError } from '@/packages/common/errors';
import {
  RATE_LIMIT_RULES,
  RATE_LIMIT_TABLE,
  enforceRateLimit,
  peekRateLimit,
  refundQuietly,
} from '@/server/platform/rate-limit';

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

function setup(): { db: TestDb['db']; userId: string } {
  ctx = createTestDb();
  return { db: ctx.db, userId: insertUser(ctx.db) };
}

/** 捕获抛出物（比 rejects.toThrow 更好断言 DomainError 的字段）。 */
async function catchThrow(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

function assertRateLimited(e: unknown): void {
  expect(isDomainError(e)).toBe(true);
  const dom = e as { code: string; context?: Record<string, unknown> };
  expect(dom.code).toBe('rate_limited');
  // "超限返回明确等待信息"：秒级等待 + 上限 + 窗口，缺一不可
  expect(Number(dom.context?.retry_after_seconds)).toBeGreaterThan(0);
  expect(Number(dom.context?.retry_after_seconds)).toBeLessThanOrEqual(60);
  expect(Number(dom.context?.limit)).toBe(5);
  expect(Number(dom.context?.window_seconds)).toBe(60);
  expect(String(dom.context?.action)).toBe('comment_change');
}

describe('规则与规格一致（防静默漂移）', () => {
  it('评论 5 次/分/用户、插件提交 10 次/时/用户，且配置键与规格文档对得上', () => {
    expect(RATE_LIMIT_RULES.comment_change.points).toBe(5);
    expect(RATE_LIMIT_RULES.comment_change.durationMs).toBe(60_000);
    expect(RATE_LIMIT_RULES.comment_change.specKey).toBe('rate_limits.comment_changes_per_minute');

    expect(RATE_LIMIT_RULES.plugin_submission.points).toBe(10);
    expect(RATE_LIMIT_RULES.plugin_submission.durationMs).toBe(3_600_000);
    expect(RATE_LIMIT_RULES.plugin_submission.specKey).toBe('rate_limits.plugin_submissions_per_hour');
  });
});

describe('表结构由我们的迁移负责', () => {
  it('迁移 0006 建出的表与库期望的三列完全一致（库升级时会在这里报警）', () => {
    const { db } = setup();
    const cols = (db.prepare(`PRAGMA table_info(${RATE_LIMIT_TABLE})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['key', 'points', 'expire']);
  });

  it('表已存在时 limiter 直接用，不需要它自建（tableCreated 路径真的走通）', async () => {
    const { db, userId } = setup();
    // 先确认迁移后表是空的
    expect(db.prepare(`SELECT count(*) AS c FROM ${RATE_LIMIT_TABLE}`).get()).toEqual({ c: 0 });

    await enforceRateLimit(db, 'comment_change', userId);

    // 只有计数行，不会多出别的表/结构
    const rows = db.prepare(`SELECT key FROM ${RATE_LIMIT_TABLE}`).all() as { key: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe(`rlflx:comment_change:${userId}`);
  });
});

describe('额度与超限', () => {
  it('前 5 次通过，第 6 次给 rate_limited 与明确等待秒数', async () => {
    const { db, userId } = setup();

    for (let i = 1; i <= 5; i += 1) {
      const ticket = await enforceRateLimit(db, 'comment_change', userId);
      expect(ticket.remainingPoints).toBe(5 - i);
    }

    assertRateLimited(await catchThrow(enforceRateLimit(db, 'comment_change', userId)));
  });

  it('超限后额度不因重试而恢复（持续打也还是被拒）', async () => {
    const { db, userId } = setup();
    for (let i = 0; i < 5; i += 1) await enforceRateLimit(db, 'comment_change', userId);
    assertRateLimited(await catchThrow(enforceRateLimit(db, 'comment_change', userId)));
    assertRateLimited(await catchThrow(enforceRateLimit(db, 'comment_change', userId)));
    // 只应该有一行计数（同一个键）
    expect(db.prepare(`SELECT count(*) AS c FROM ${RATE_LIMIT_TABLE}`).get()).toEqual({ c: 1 });
  });

  it('不同用户、不同动作各自独立计数', async () => {
    const { db, userId } = setup();
    const other = insertUser(db, { nickname: '另一个人' });

    for (let i = 0; i < 5; i += 1) await enforceRateLimit(db, 'comment_change', userId);

    // 别人不受影响
    expect((await enforceRateLimit(db, 'comment_change', other)).remainingPoints).toBe(4);
    // 同一个人的另一个动作也不受影响（插件提交是 10/时）
    expect((await enforceRateLimit(db, 'plugin_submission', userId)).remainingPoints).toBe(9);
  });

  it('**并发不超发**：同一用户同时打 20 次，恰好放过 5 次', async () => {
    const { db, userId } = setup();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => enforceRateLimit(db, 'comment_change', userId)),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(5);
    expect(rejected).toBe(15);

    // 库里记的是**原始计数** 20（超额请求也会被加上去），不是被截断的 5 —— 这是库的语义：
    // 计数行 points=20，而 expire 保持第一次写入的窗口终点不变（超额刷**不会**延长封禁）。
    // 真正要钉住的是"放过了几个"（上面 ok===5），以及下面这条：计数没有被并发撕成中间值。
    const row = db.prepare(`SELECT points, expire FROM ${RATE_LIMIT_TABLE} WHERE key = ?`).get(
      `rlflx:comment_change:${userId}`,
    ) as { points: number; expire: number };
    expect(row.points).toBe(20);
    expect(row.expire).toBeGreaterThan(Date.now());
  });

  it('**过期即重置**：窗口到期后重新拿到满额度', async () => {
    const { db, userId } = setup();
    for (let i = 0; i < 5; i += 1) await enforceRateLimit(db, 'comment_change', userId);
    assertRateLimited(await catchThrow(enforceRateLimit(db, 'comment_change', userId)));

    // 模拟时间流逝：把窗口到期时间挪到过去（库里存的是绝对 UTC 毫秒）
    db.prepare(`UPDATE ${RATE_LIMIT_TABLE} SET expire = ?`).run(Date.now() - 1_000);

    expect((await enforceRateLimit(db, 'comment_change', userId)).remainingPoints).toBe(4);
  });
});

describe('退还（幂等重放 / 失败不退业务额度）', () => {
  it('退还一次后额度真的回来（重放不另算一次提交）', async () => {
    const { db, userId } = setup();
    // 注意：这里**故意不再打一次"超额请求"** —— 被拒的请求也会把原始计数加上去（库的语义），
    // 那会让"退还 1 点"不足以回到额度内，测出来像是退还坏了。
    const first = await enforceRateLimit(db, 'comment_change', userId);
    for (let i = 0; i < 4; i += 1) await enforceRateLimit(db, 'comment_change', userId);

    await first.refund();

    const again = await enforceRateLimit(db, 'comment_change', userId);
    expect(again.remainingPoints).toBe(0);
  });

  it('被拒的请求也会计入原始计数，但不延长窗口（刷不会把封禁越刷越长）', async () => {
    const { db, userId } = setup();
    for (let i = 0; i < 5; i += 1) await enforceRateLimit(db, 'comment_change', userId);
    const before = db.prepare(`SELECT points, expire FROM ${RATE_LIMIT_TABLE}`).get() as {
      points: number;
      expire: number;
    };

    // 连续被拒 3 次
    for (let i = 0; i < 3; i += 1) assertRateLimited(await catchThrow(enforceRateLimit(db, 'comment_change', userId)));

    const after = db.prepare(`SELECT points, expire FROM ${RATE_LIMIT_TABLE}`).get() as {
      points: number;
      expire: number;
    };
    expect(after.points).toBe(before.points + 3); // 计数涨了
    expect(after.expire).toBe(before.expire); // 窗口终点没被推后
  });

  it('refundQuietly 对 null 安全，且退还出错不会把原始错误盖掉', async () => {
    await expect(refundQuietly(null)).resolves.toBeUndefined();
    await expect(
      refundQuietly({
        action: 'comment_change',
        key: 'k',
        remainingPoints: 0,
        rule: RATE_LIMIT_RULES.comment_change,
        refund: async () => {
          throw new Error('存储炸了');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('peek 只读不消耗（诊断用）', async () => {
    const { db, userId } = setup();
    await enforceRateLimit(db, 'comment_change', userId);
    expect(await peekRateLimit(db, 'comment_change', userId)).toEqual({ consumedPoints: 1, remainingPoints: 4 });
    // 连续 peek 不改变计数
    expect(await peekRateLimit(db, 'comment_change', userId)).toEqual({ consumedPoints: 1, remainingPoints: 4 });
  });
});

describe('误用保护', () => {
  it('匿名（userId 为空）直接抛内部错误，绝不静默放行', async () => {
    const { db } = setup();
    const e = await catchThrow(enforceRateLimit(db, 'comment_change', ''));
    expect(isDomainError(e)).toBe(true);
    expect((e as { code: string }).code).toBe('internal');
    // 关键：没有写下任何计数行（没放行，也没占额度）
    expect(db.prepare(`SELECT count(*) AS c FROM ${RATE_LIMIT_TABLE}`).get()).toEqual({ c: 0 });
  });
});
