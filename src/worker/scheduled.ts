/**
 * 定时排入的任务（当前只有"每日插件目录自动发现"）。
 *
 * ## 为什么不用宿主 cron / systemd timer
 *
 * 排程写在 **worker 进程自己**里，靠"按天幂等的 dedup key + 每次启动都试着排一次"实现：
 *   * 容器化后照样工作（不依赖宿主装了 cron，也不用在 compose 里加 sidecar）；
 *   * **重启能自愈**：worker 重启后如果发现"今天这一天还没排过"，会补排一次；
 *   * 天然幂等：`UNIQUE(task_type, deduplication_key)` 让重复排入复用同一任务。
 *
 * 代价（如实写在这）：如果一整天 worker 都没运行，那一天的发现就**跳过**了（次日再跑），
 * 不会事后补跑历史日期 —— 对"插件目录同步"这种非关键任务，这是可接受的取舍。
 *
 * ## 关掉它的两种方式
 *
 *   * `DSH_REVIEW_CATALOG_OFFLINE=1`：离线模式（CI/本地），排了也只会失败，索性不排；
 *   * `DSH_REVIEW_DISCOVERY_DAILY=0`：显式关闭每日发现（线上临时刹车用）。
 */

import { log } from '@/server/platform/log';
import { nowMs } from '@/server/platform/time';
import type { SqliteDatabase } from '@/server/platform/db';
import { discoveryDailyKey, discoveryBudgetFor, DISCOVERY_DEFAULTS } from '@/server/modules/catalog/discovery';
import { discoverySettingsFrom } from '@/server/modules/settings';
import type { TasksService } from '@/server/modules/tasks/service';

/** 排程检查间隔：不必每 tick 都查（一个 SELECT 而已，但也没必要每秒一次）。 */
export const DISCOVERY_SCHEDULE_CHECK_MS = 60_000;

/** 调度组：与用户任务分开，便于观测"系统调度"占了多少。 */
export const DISCOVERY_SCHEDULING_GROUP = 'plugin_discovery_schedule';

export interface ScheduleEnvView {
  DSH_REVIEW_CATALOG_OFFLINE?: string;
  DSH_REVIEW_DISCOVERY_DAILY?: string;
  /** 预算分档看它：未认证时 GitHub 核心接口只有 60 次/小时（见 discoveryBudgetFor）。 */
  GITHUB_TOKEN?: string;
  [key: string]: string | undefined;
}

/**
 * 是否应跳过排入；返回**原因**（不跳过则返回 null）。
 * 把原因返回而不是只返回布尔值：日志里能直接说明"为什么今天没排"。
 */
export function discoveryScheduleSkipReason(env: ScheduleEnvView): string | null {
  if (env.DSH_REVIEW_CATALOG_OFFLINE === '1') {
    return 'DSH_REVIEW_CATALOG_OFFLINE=1：离线模式，不排入发现任务。';
  }
  if (env.DSH_REVIEW_DISCOVERY_DAILY === '0') {
    return 'DSH_REVIEW_DISCOVERY_DAILY=0：每日发现被显式关闭。';
  }
  return null;
}

export interface EnsureDailyDiscoveryResult {
  /** 本次调用是否**新建**了任务（false = 今天已经排过了）。 */
  created: boolean;
  taskId: string | null;
  deduplicationKey: string;
  /** 非 null 表示"没排"，里面是原因。 */
  skippedReason: string | null;
}

/**
 * 保证"今天这一天"的发现任务已经排入（幂等；可反复调用）。
 *
 * 预算与开关的优先级：**环境变量（硬刹车）> 后台配置 > 按 token 的默认档**。
 * 硬刹车留给运维（出事时一行 env 就能停），日常调整交给后台配置页。
 */
export async function ensureDailyDiscoveryTask(deps: {
  tasks: TasksService;
  now?: number;
  env?: ScheduleEnvView;
  /** 给了就读后台配置（`discovery.daily_enabled` / `discovery.max_plugins_per_run`）。 */
  db?: SqliteDatabase;
}): Promise<EnsureDailyDiscoveryResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? nowMs();
  const key = discoveryDailyKey(now);

  const skippedReason = discoveryScheduleSkipReason(env);
  if (skippedReason !== null) {
    return { created: false, taskId: null, deduplicationKey: key, skippedReason };
  }

  // 后台配置：每日开关 + 每轮上限（取"配置值"与"按 token 的档位"里更小的那个，
  // 因为配额是硬约束，配置不该把它顶穿）。
  let maxPluginsCap = Number.POSITIVE_INFINITY;
  if (deps.db) {
    const settings = discoverySettingsFrom(deps.db);
    if (!settings.dailyEnabled) {
      return {
        created: false,
        taskId: null,
        deduplicationKey: key,
        skippedReason: '后台配置里「每日自动发现」已关闭（discovery.daily_enabled=false）。',
      };
    }
    maxPluginsCap = settings.maxPluginsPerRun;
  }

  const budget = discoveryBudgetFor(env);
  const { taskId, created } = await deps.tasks.enqueue({
    taskType: 'plugin_discovery',
    deduplicationKey: key,
    // 系统排入：没有具体请求人（requested_by 允许 NULL），审计走 operation_records 的 system 身份。
    requestedBy: null,
    // ⚠️ payload 键名必须与 handlers.ts 的读取名**一致**：这里用 snake_case
    // （与 `submission_id` 等既有 payload 同风格）。曾经这里写成 camelCase，
    // 结果 handler 读不到 → 预算被静默忽略（真实踩过：线上第一轮用了 60 个候选，
    // 而不是预算里的 20）。tests/plugin-discovery.test.ts 里有专门的防漂移用例。
    payload: {
      run_key: key,
      query: DISCOVERY_DEFAULTS.query,
      search_pages: budget.searchPages,
      per_page: budget.perPage,
      max_candidates: budget.maxCandidates,
      max_plugins: Math.min(budget.maxPlugins, maxPluginsCap),
      max_requests: budget.maxRequests,
    },
    schedulingGroup: DISCOVERY_SCHEDULING_GROUP,
    availableAt: now,
  });

  if (created) {
    log.info('已排入当天的插件自动发现任务', { task_id: taskId, deduplication_key: key });
  }
  return { created, taskId, deduplicationKey: key, skippedReason: null };
}
