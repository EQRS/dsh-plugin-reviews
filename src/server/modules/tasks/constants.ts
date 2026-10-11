/**
 * 任务队列参数常量（模块签名契约第 7 节 / 架构第 101、102、103 节）。
 *
 * 出处：docs/模块签名契约.md 第 176-177 行原文
 *   「参数（架构第 101、102、103 节）：`max_concurrent=4`、`lease=120s`、`renew=30s`、
 *     `recovery_scan=10s`、普通可恢复故障最多 3 次、等待序列 `[30s, 120s]`、
 *     常规单次任务上限 `300s`。」
 *
 * 这些值必须是**模块内常量**而不是散落字面量：测试直接引用它们，
 * 实现里改掉任何一个都会让对应用例变红。
 */

import { SECOND } from '@/server/platform/time';

/** 架构第 101 节：全站同时运行的任务数上限。 */
export const MAX_CONCURRENT_TASKS = 4;

/** 架构第 102 节：一次领取的执行权租期（毫秒）。 */
export const LEASE_DURATION_MS = 120 * SECOND;

/** 架构第 102 节：worker 续期间隔（毫秒）。必须显著小于租期。 */
export const RENEW_INTERVAL_MS = 30 * SECOND;

/** 架构第 103 节：到期租约扫描间隔（毫秒）。 */
export const RECOVERY_SCAN_INTERVAL_MS = 10 * SECOND;

/**
 * 架构第 103 节：普通可恢复故障的最大尝试次数。
 * 注意语义：这是**每个 retry_cycle 内**的尝试上限，与
 * `background_tasks.cycle_attempt_count <= attempt_count` 的关系一致。
 */
export const MAX_RECOVERABLE_ATTEMPTS = 3;

/**
 * 架构第 103 节：可恢复故障的等待序列（毫秒）。
 * 第 1 次失败（已尝试 1 次）后等 30s；第 2 次失败后等 120s；
 * 第 3 次失败即达到上限 → 终态 failed，不再产生新的等待时长。
 */
export const RETRY_BACKOFF_MS: readonly number[] = [30 * SECOND, 120 * SECOND];

/**
 * 架构第 103 节：单次常规任务的最长执行时间（毫秒）。
 * worker 用它写 attempt.deadline_at；超过后由 recoverExpired 兜底回收。
 */
export const TASK_DEADLINE_MS = 300 * SECOND;

/** worker 空转时的休眠间隔（毫秒）：与到期扫描同频，避免无效轮询。 */
export const IDLE_SLEEP_MS = RECOVERY_SCAN_INTERVAL_MS;

/**
 * 根据「已累计的尝试次数」计算下一次可执行时刻。
 *
 * 入参 `attemptCount` 是**含本次在内的累计尝试数**（`background_tasks.attempt_count`
 * 在 claim 时已自增）。返回 null 表示已达上限，应当进入终态 failed。
 *
 * 语义对齐「最多 3 次」：第 1 次失败 → 等 30s；第 2 次失败 → 等 120s；
 * 第 3 次失败 → 预算耗尽，进入 failed。
 */
export function nextAvailableAt(attemptCount: number, now: number): number | null {
  if (attemptCount >= MAX_RECOVERABLE_ATTEMPTS) return null;
  const index = Math.max(0, Math.min(attemptCount - 1, RETRY_BACKOFF_MS.length - 1));
  const backoff = RETRY_BACKOFF_MS[index];
  return now + (backoff ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0);
}
