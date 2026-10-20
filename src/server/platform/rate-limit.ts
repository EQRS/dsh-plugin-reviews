/**
 * 请求频控（`参数与管理规则.md` 第 3 节）。
 *
 * 规格要求（逐条对应到实现）：
 *   * **按服务端确认的站内用户 + 业务动作 + 窗口**计算 → 键 = `<动作>:<userId>`，
 *     额度只认服务端读出来的 userId，**前端传什么都不影响**；
 *   * 评论变更（新评论 / 回复 / 正文修改）**合并计数** → 三种写入共用 `comment_change` 一个键；
 *   * **相同已成功请求键的重放返回原结果，不另算一次提交** → 调用方在拿到"重放"结果时
 *     调用 `ticket.refund()` 退还额度（见 routes 里的用法）；
 *   * **超限返回明确等待信息** → 抛 `err.rateLimited(...)`，`context.retry_after_seconds`
 *     给到秒级等待（HTTP 429，见 `errors-http.ts`）；
 *   * **不能靠多窗口绕过** → 计数在服务端库里，换标签页/刷新/改前端都不影响。
 *
 * 为什么用库而不是自己写：这里最难的不是"数数"，而是**并发下的原子自增**。
 * rate-limiter-flexible 的 SQLite store 用的是一条语句搞定（已核对其源码 11.2.2）：
 *
 *     INSERT INTO <表> (key, points, expire) VALUES (?, ?, ?)
 *     ON CONFLICT(key) DO UPDATE SET
 *       points = CASE WHEN expire IS NULL OR expire > ? THEN points + excluded.points ELSE excluded.points END,
 *       expire = CASE WHEN expire IS NULL OR expire > ? THEN expire ELSE excluded.expire END
 *     RETURNING points, expire
 *
 * 单条语句 + 事务包装 → 不会"两个请求都读到 4 再各写 5"。过期即重置的逻辑也在同一条语句里。
 *
 * ⚠️ 三点**如实说明**的行为/偏差（不要读成"完全符合规格"）：
 *   1. 它的窗口是"**从该用户第一次操作开始计时**"的固定窗口（叫 enhanced fixed window），
 *      不是严格滑动窗口：在窗口交界处（如第 59 秒发 5 条、第 61 秒再发 5 条）短时间内可到 2 倍。
 *      对防滥用够用（持续速率仍被压住）；要严格滑动窗口得用两个偏移限流器组合，另开一片。
 *   2. 规则目前是**模块常量**，还不能在后台调整（规格要求"限额在后台可调整"）——
 *      那需要接 `site_settings`（目前全仓零读写的表），属于后续切片。
 *   3. **被拒的请求也会把原始计数加上去**（库的语义），所以计数行的 points 会超过上限；
 *      但窗口终点 `expire` 保持第一次写入的值，**超额刷不会把封禁越刷越长**。
 *      推论：退还只在"**已经拿到 ticket**"之后才有意义 —— 被拒的请求根本没有 ticket，
 *      也正因如此，路由里"出错就退还"只会退掉那些"通过了限流但业务失败"的请求。
 */

import { RateLimiterSQLite } from 'rate-limiter-flexible';
import type { SqliteDatabase } from './db';
import { err } from '@/packages/common/errors';
import { log } from './log';

/** 存储表名（迁移 0006 建；库用 `tableCreated: true` 直接用它）。 */
export const RATE_LIMIT_TABLE = 'rate_limiter_flexible';

/** 业务动作：一个动作一个独立额度。 */
export type RateLimitAction = 'comment_change' | 'plugin_submission' | 'report' | 'correction';

export interface RateLimitRule {
  action: RateLimitAction;
  /** 规格里的配置键（方便日后接 `site_settings` 时一一对应）。 */
  specKey: string;
  points: number;
  durationMs: number;
  /** 人类可读的口径，直接进错误信息。 */
  description: string;
}

/** 首版建议值，**逐字对应** `参数与管理规则.md` 第 22-25 行。测试会盯住这几个数字。 */
export const RATE_LIMIT_RULES: Record<RateLimitAction, RateLimitRule> = {
  comment_change: {
    action: 'comment_change',
    specKey: 'rate_limits.comment_changes_per_minute',
    points: 5,
    durationMs: 60_000,
    description: '每用户每分钟最多 5 次新评论、回复或正文修改',
  },
  plugin_submission: {
    action: 'plugin_submission',
    specKey: 'rate_limits.plugin_submissions_per_hour',
    points: 10,
    durationMs: 3_600_000,
    description: '每用户每小时最多 10 次新的指定插件提交检查',
  },
  report: {
    action: 'report',
    specKey: 'rate_limits.reports_per_hour',
    points: 20,
    durationMs: 3_600_000,
    description: '每用户每小时最多 20 次举报提交',
  },
  correction: {
    action: 'correction',
    specKey: 'rate_limits.corrections_per_hour',
    points: 10,
    durationMs: 3_600_000,
    description: '每用户每小时最多 10 次资料纠错提交',
  },
};

/**
 * 一次通过了的频控检查。调用方必须在**没有产生新的业务变更**时退还额度：
 *   * 幂等重放（同一 requestKey 返回原结果）—— 规格明确要求不另算；
 *   * 操作抛错（未产生任何变更）—— 规格把"无效输入"划给独立的请求防护，
 *     不该用业务计数去冒充全局限流。
 */
export interface RateLimitTicket {
  action: RateLimitAction;
  key: string;
  remainingPoints: number;
  rule: RateLimitRule;
  /** 退还本次消耗的额度（幂等重放 / 失败时调用）。 */
  refund: () => Promise<void>;
}

/**
 * limiter 实例缓存：按 **db 实例 + 动作** 复用。
 *
 * 用 WeakMap 而不是模块级单例：测试会建很多临时库，缓存串了会让"每个库各自计数"失效。
 * 也不要在每次请求里 new：那会每次构造都跑一遍库内部的初始化。
 */
const limiterCache = new WeakMap<SqliteDatabase, Map<string, RateLimiterSQLite>>();

function limiterFor(db: SqliteDatabase, rule: RateLimitRule): RateLimiterSQLite {
  let byAction = limiterCache.get(db);
  if (!byAction) {
    byAction = new Map();
    limiterCache.set(db, byAction);
  }
  // 缓存键**必须带上生效的数值**：上限现在可以在后台调（见 modules/settings），
  // 只按动作名缓存的话，管理员把 5 改成 10 之后仍会命中旧 limiter（上限还是 5）——
  // 那种"改了不生效"最难查。带宽高之后旧实例留着也无害（进程重启即清）。
  const cacheKey = `${rule.action}:${rule.points}:${rule.durationMs}`;
  const cached = byAction.get(cacheKey);
  if (cached) return cached;

  const limiter = new RateLimiterSQLite({
    storeClient: db,
    // 我们用的是 better-sqlite3（同步驱动），必须显式声明，否则库按 sqlite3 走。
    storeType: 'better-sqlite3',
    tableName: RATE_LIMIT_TABLE,
    points: rule.points,
    // 库的 duration 单位是**秒**。
    duration: Math.round(rule.durationMs / 1000),
    // 表由迁移 0006 建，不让库自己建（保持"迁移是权威结构"）。
    tableCreated: true,
    // 不开启库的定时清理：它会 setInterval，而我们要进程能被干净关掉。
    // 过期行不清理也不会涨爆 —— 键是"用户 × 动作"，与用户数同阶（见 README 的口径）。
    clearExpiredByTimeout: false,
  });
  byAction.set(cacheKey, limiter);
  return limiter;
}

/**
 * 消耗一次额度；超限抛 `rate_limited`（HTTP 429）并带等待秒数。
 *
 * 调用位置纪律：**必须在真正做昂贵/写库的动作之前**调用（比如插件收录要出网探测 GitHub），
 * 所以要自己先做 `assertCanWrite(ctx)` 把匿名挡掉，否则会先花掉探测请求再被业务层拒绝。
 */
export async function enforceRateLimit(
  db: SqliteDatabase,
  action: RateLimitAction,
  userId: string,
  points = 1,
  /**
   * 生效值覆盖（来自后台配置，见 modules/settings）。
   *
   * 只覆盖**数值**，不覆盖动作名/规格键/文案：否则"这条限流是哪条规格"就说不清了。
   * 非法数值（非正整数）一律忽略、回落到默认值 —— 配置坏了不该把接口打瘫。
   */
  override?: { points?: number; durationMs?: number },
): Promise<RateLimitTicket> {
  if (typeof userId !== 'string' || userId.length === 0) {
    // 编程错误：所有挂了频控的动作都要求登录。这里宁可响亮地失败，
    // 也不要静默放行（静默放行 = 匿名可以无限打昂贵接口）。
    throw err.internal('频控需要已确认的登录用户，不应以匿名身份调用。');
  }

  const base = RATE_LIMIT_RULES[action];
  const rule: RateLimitRule = {
    ...base,
    ...(typeof override?.points === 'number' && Number.isInteger(override.points) && override.points > 0
      ? { points: override.points }
      : {}),
    ...(typeof override?.durationMs === 'number' && override.durationMs > 0
      ? { durationMs: override.durationMs }
      : {}),
  };
  const limiter = limiterFor(db, rule);
  const key = `${rule.action}:${userId}`;

  try {
    const res = await limiter.consume(key, points);
    return {
      action: rule.action,
      key,
      remainingPoints: res.remainingPoints,
      rule,
      refund: async () => {
        await limiter.reward(key, points);
      },
    };
  } catch (rejection) {
    // 库用 reject(RateLimiterRes) 表达"超额"；真正的异常才是代码/存储故障，要原样抛出。
    if (rejection instanceof Error) throw rejection;
    const msBeforeNext = Number((rejection as { msBeforeNext?: unknown })?.msBeforeNext ?? 0);
    const seconds = Number.isFinite(msBeforeNext) && msBeforeNext > 0 ? Math.ceil(msBeforeNext / 1000) : 1;
    throw err.rateLimited(`操作太频繁：${rule.description}，请在 ${seconds} 秒后重试。`, {
      action: rule.action,
      retry_after_seconds: seconds,
      limit: rule.points,
      window_seconds: Math.round(rule.durationMs / 1000),
    });
  }
}

/** 只读查询当前剩余额度（用于验收脚本与诊断，不消耗）。 */
export async function peekRateLimit(
  db: SqliteDatabase,
  action: RateLimitAction,
  userId: string,
  override?: { points?: number; durationMs?: number },
): Promise<{ consumedPoints: number; remainingPoints: number }> {
  const base = RATE_LIMIT_RULES[action];
  const rule: RateLimitRule = {
    ...base,
    ...(typeof override?.points === 'number' && Number.isInteger(override.points) && override.points > 0
      ? { points: override.points }
      : {}),
    ...(typeof override?.durationMs === 'number' && override.durationMs > 0
      ? { durationMs: override.durationMs }
      : {}),
  };
  const limiter = limiterFor(db, rule);
  const res = await limiter.get(`${rule.action}:${userId}`);
  const consumed = res?.consumedPoints ?? 0;
  return { consumedPoints: consumed, remainingPoints: Math.max(0, rule.points - consumed) };
}

/**
 * 尽力而为地退还额度。
 *
 * 为什么单独一个函数：退还是"善后"，**绝不能盖住原始错误** ——
 * 如果退款本身抛错而我们在 catch 里直接 `await ticket.refund()`，
 * 用户看到的会变成"退款失败"，而真正的失败原因（比如业务校验不通过）被吞掉。
 * 所以这里吞掉退还的错误、只记一条日志。
 */
export async function refundQuietly(ticket: RateLimitTicket | null | undefined): Promise<void> {
  if (!ticket) return;
  try {
    await ticket.refund();
  } catch (error) {
    log.warn('rate_limit_refund_failed', {
      action: ticket.action,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
