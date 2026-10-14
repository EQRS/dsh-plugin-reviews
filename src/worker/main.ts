/**
 * worker 独立进程入口（工作包 GT）。
 *
 * 契约（模块签名契约 §7 / 架构第 48、59 节）：
 *  循环 claim → 分发到已注册处理器 → 续期 → finish；无任务时按间隔休眠；
 *  SIGTERM 优雅退出（不再领新任务，等在跑的任务结束或租约到期）。
 *
 * 本文件**不依赖网页**：不 import 任何 Next / React 代码，只依赖平台层与任务模块。
 */

import { getDb, closeDb, type SqliteDatabase } from '@/server/platform/db';
import { nowMs } from '@/server/platform/time';
import { log } from '@/server/platform/log';
import { newId } from '@/server/platform/id';
import {
  WORKER_BEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_NAME,
  WORKER_STALE_MS,
  startHeartbeat,
} from '@/server/platform/heartbeat';
import type { TaskType } from '@/packages/common/field-rules';
import { createTasksService } from '@/server/modules/tasks/service';
import { ensureDailyDiscoveryTask, discoveryScheduleSkipReason, DISCOVERY_SCHEDULE_CHECK_MS } from './scheduled';
import type { ClaimedTask, TasksService } from '@/server/modules/tasks/service';
import { createHandlers } from './handlers';
import { basicScreenEnabled } from './content-screen';
import {
  IDLE_SLEEP_MS,
  MAX_CONCURRENT_TASKS,
  RECOVERY_SCAN_INTERVAL_MS,
  RENEW_INTERVAL_MS,
} from '@/server/modules/tasks/constants';

/** 处理器返回值 → finish 的 outcome 映射。 */
export interface HandlerResult {
  outcome: 'success' | 'error' | 'skipped';
  errorCode?: string;
  errorSummary?: string;
  /** 结构化结果，随任务落进 `background_tasks.progress`（后台页据此展示"这一轮做了什么"）。 */
  progress?: unknown;
}

export type TaskHandler = (task: ClaimedTask) => Promise<HandlerResult>;

export interface WorkerOptions {
  /** worker 标识，写进 lease_owner 与 attempt.worker_reference。 */
  workerReference: string;
  /** 已注册的处理器：未注册的任务类型会被判为 skipped（不静默成功）。 */
  handlers: Partial<Record<TaskType, TaskHandler>>;
  /** 休眠函数（测试可注入）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次循环最多领取几个任务（不超过 MAX_CONCURRENT_TASKS）。 */
  maxConcurrent?: number;
  /** 单次循环后是否继续；返回 false 则优雅退出。 */
  shouldContinue?: () => boolean;
  /** 任务模块（测试可注入；默认用进程单例）。 */
  tasks?: TasksService;
  /** 每轮循环开头的回调（真实入口用它写运行时心跳；测试可不传）。 */
  onTick?: () => void;
  /**
   * 是否在循环里排入**定时任务**（每日插件目录自动发现）。
   *
   * 默认 **false**：定时排程是"会自己产生任务"的行为，隐式打开会让
   * "领一个任务、处理一个任务"的测试与调试场景凭空多出任务。
   * 真实入口显式传 true（并会打日志说明状态）。
   */
  scheduledTasks?: boolean;
  /**
   * 排定时任务时读后台配置用的连接（`discovery.daily_enabled` / `discovery.max_plugins_per_run`）。
   * 不传就只用环境变量与按 token 的默认档 —— 生产入口会传。
   */
  settingsDb?: SqliteDatabase;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * worker 主体。`runOnce` 领一批并执行；`run` 循环到 shouldContinue 为 false。
 */
export function createWorker(options: WorkerOptions) {
  const sleep = options.sleep ?? realSleep;
  const tasks = options.tasks ?? createTasksService(getDb());
  const maxConcurrent = Math.min(options.maxConcurrent ?? MAX_CONCURRENT_TASKS, MAX_CONCURRENT_TASKS);
  /** 下一次尝试排入定时任务的时间（0 = 启动后立刻试一次）。 */
  let nextScheduleCheckAt = 0;

  /** 执行单个已领取的任务；内部负责续期与 finish。 */
  async function execute(claim: ClaimedTask): Promise<void> {
    const handler = options.handlers[claim.taskType];

    if (!handler) {
      // 未注册处理器：明确记 skipped，不假装成功。
      await tasks.finish(
        { taskId: claim.taskId, executionToken: claim.executionToken },
        {
          outcome: 'skipped',
          errorCode: 'no_handler',
          errorSummary: `没有为任务类型 ${claim.taskType} 注册处理器。`,
          now: nowMs(),
        },
      );
      log.warn('任务被跳过：未注册处理器', { task_id: claim.taskId, task_type: claim.taskType });
      return;
    }

    // 续期定时器：间隔 RENEW_INTERVAL_MS，远小于租期 LEASE_DURATION_MS。
    // 续期失败（token 被顶替或租约已过期）→ 立刻停止写回，放弃本次执行。
    let leaseLost = false;
    const timer = setInterval(() => {
      void tasks
        .renew({ taskId: claim.taskId, executionToken: claim.executionToken }, nowMs())
        .then((ok) => {
          if (!ok) {
            leaseLost = true;
            log.warn('续期失败：执行权已失效，放弃本次执行', { task_id: claim.taskId });
          }
        })
        .catch(() => {
          leaseLost = true;
        });
    }, RENEW_INTERVAL_MS);
    // 不阻止进程退出。
    if (typeof timer.unref === 'function') timer.unref();

    let result: HandlerResult;
    try {
      result = await handler(claim);
    } catch (e) {
      result = {
        outcome: 'error',
        errorCode: 'handler_threw',
        errorSummary: e instanceof Error ? e.message : '处理器抛出未知错误。',
      };
    } finally {
      clearInterval(timer);
    }

    if (leaseLost) {
      log.warn('执行权已失效，不写回结果', { task_id: claim.taskId });
      return;
    }

    try {
      await tasks.finish(
        { taskId: claim.taskId, executionToken: claim.executionToken },
        {
          outcome: result.outcome,
          errorCode: result.errorCode,
          errorSummary: result.errorSummary,
          progress: result.progress,
          now: nowMs(),
        },
      );
      log.info('任务结束', {
        task_id: claim.taskId,
        task_type: claim.taskType,
        outcome: result.outcome,
      });
    } catch (e) {
      // 典型情况：租约在执行途中到期，finish 的 CAS 被拒。这不是崩溃，
      // 任务会被 recoverExpired 重新安排。
      log.warn('写回被拒绝（执行权已失效）', {
        task_id: claim.taskId,
        error: e instanceof Error ? e.message : 'unknown',
      });
    }
  }

  /** 跑一轮：到期恢复 + 定时排程（每天一次）+ 领一批任务并执行。返回本轮执行的任务数。 */
  async function runOnce(): Promise<number> {
    options.onTick?.();
    const now = nowMs();
    const recovered = await tasks.recoverExpired(now);
    if (recovered > 0) log.info('回收到期租约', { count: recovered });

    // 定时排程：不必每 tick 都查（间隔见 DISCOVERY_SCHEDULE_CHECK_MS）。
    // 排程失败**不能**拖垮主循环：记日志后继续跑任务（下一轮还会再试）。
    if (options.scheduledTasks === true && now >= nextScheduleCheckAt) {
      nextScheduleCheckAt = now + DISCOVERY_SCHEDULE_CHECK_MS;
      try {
        const scheduled = await ensureDailyDiscoveryTask({ tasks, now, db: options.settingsDb });
        if (scheduled.skippedReason !== null) {
          log.info('未排入自动发现任务', { reason: scheduled.skippedReason });
        }
      } catch (e) {
        log.error('排入自动发现任务失败', { error: e instanceof Error ? e.message : 'unknown' });
      }
    }

    const claims: ClaimedTask[] = [];
    for (let i = 0; i < maxConcurrent; i += 1) {
      const claim = await tasks.claim(options.workerReference, nowMs());
      if (!claim) break;
      claims.push(claim);
    }

    if (claims.length === 0) return 0;

    // 本切片按顺序执行（better-sqlite3 是同步驱动，处理器主要做 DB 与轻量工作）。
    // 并发上限由「一轮领多少」表达。
    for (const claim of claims) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      await execute(claim);
    }
    return claims.length;
  }

  /** 主循环：无任务时按 IDLE_SLEEP_MS 休眠（与到期扫描同频）。 */
  async function run(): Promise<void> {
    log.info('worker 启动', { worker_reference: options.workerReference, max_concurrent: maxConcurrent });
    while (!options.shouldContinue || options.shouldContinue()) {
      let handled = 0;
      try {
        handled = await runOnce();
      } catch (e) {
        log.error('worker 循环出错', { error: e instanceof Error ? e.message : 'unknown' });
        handled = 0;
      }
      if (handled === 0) await sleep(IDLE_SLEEP_MS);
    }
    log.info('worker 退出循环', { worker_reference: options.workerReference });
  }

  return { run, runOnce, execute, maxConcurrent };
}

/** 真正的进程入口：装配默认处理器、处理信号、运行主循环。 */
export async function main(): Promise<void> {
  const db = getDb();
  const tasks = createTasksService(db);
  const workerReference = `worker-${newId()}`;

  // 真实处理器注册表（工作包 GT / task-6）：四条闭环
  //   提交评测 → review_check → （通过则入队）review_publish → published
  //   提交评论 → comment_check → （通过则入队）comment_publish → published
  //
  // 筛查开关由 DSH_REVIEW_CONTENT_SCREEN 控制：未设为 `basic` 时**不注入**筛查，
  // moderation 会落 not_configured → manual_review（保守，绝不自动放行）。
  const handlers = createHandlers({ db });
  log.info('已装配任务处理器', {
    worker_reference: workerReference,
    handler_count: Object.keys(handlers).length,
    content_screen: basicScreenEnabled() ? 'basic' : 'disabled',
    scheduled_tasks: true,
    discovery_skip_reason: discoveryScheduleSkipReason(process.env),
  });

  let running = true;
  const stop = (signal: string) => {
    if (!running) return;
    running = false;
    log.info('收到退出信号，准备优雅退出', { signal });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // 运行时心跳：**固定间隔**写（不能只靠每轮循环写 —— 一个跑很久的任务会让心跳
  // 在任务期间变旧，那会把"正在干活"误判成"卡死"）。
  const heartbeat = startHeartbeat(db, WORKER_HEARTBEAT_NAME, {
    detail: () => ({ worker_reference: workerReference, pid: process.pid }),
  });
  log.info('已开始写运行时心跳', {
    worker_reference: workerReference,
    interval_ms: WORKER_BEAT_INTERVAL_MS,
    stale_ms: WORKER_STALE_MS,
  });

  const worker = createWorker({
    workerReference,
    handlers,
    tasks,
    shouldContinue: () => running,
    onTick: () => heartbeat.beatNow(),
    // 生产入口打开定时排程（每日插件自动发现）；关掉的方式见 worker/scheduled.ts。
    // settingsDb 让排程能读后台配置（每日开关 / 每轮上限）。
    scheduledTasks: true,
    settingsDb: db,
  });

  try {
    await worker.run();
  } finally {
    heartbeat.stop();
    closeDb();
  }
}

// 直接以 `tsx src/worker/main.ts` 运行时才启动主循环；
// 被 import（例如测试）时不自动启动。
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  /(?:^|[\\/])worker[\\/]main\.(ts|js|mts|mjs)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((e: unknown) => {
    log.error('worker 启动失败', { error: e instanceof Error ? e.message : 'unknown' });
    process.exitCode = 1;
  });
}

export { MAX_CONCURRENT_TASKS, RENEW_INTERVAL_MS, RECOVERY_SCAN_INTERVAL_MS, IDLE_SLEEP_MS };
