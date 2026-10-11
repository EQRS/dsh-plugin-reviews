/**
 * tasks 模块公共出口（架构第 67.2 节：每个业务模块提供明确的公共入口）。
 *
 * 为什么加这一层：主控裁决（2026-10-11）——
 *  - 导出形状以**实际实现**为准：工厂 `createTasksService(db)` + 单例访问器 `tasksService()`。
 *    工厂优先，因为它让调用方显式传入**同一条连接**；若只有单例，评论写入走注入连接、
 *    而任务入队走 getDb() 单例时，会写出指向别处数据库的任务（看着成功、实际对不上）。
 *  - 但调用方不应深入 `service.ts`。此前 comments 只能写
 *    `import('@/server/modules/tasks/service')`，属于"缺少公共入口"的补救。
 *    本文件把公共入口补上，实现文件位置变化时调用方不受影响。
 */

export {
  createTasksService,
  tasksService,
  resetTasksService,
} from './service';

export type { TasksService, ClaimedTask } from './service';
export type { TaskState, TaskType } from './service';

// 参数常量（架构第 101—103 节）。名字以 constants.ts 实际导出为准。
export {
  MAX_CONCURRENT_TASKS,
  LEASE_DURATION_MS,
  RENEW_INTERVAL_MS,
  RECOVERY_SCAN_INTERVAL_MS,
  MAX_RECOVERABLE_ATTEMPTS,
  RETRY_BACKOFF_MS,
  TASK_DEADLINE_MS,
  IDLE_SLEEP_MS,
  nextAvailableAt,
} from './constants';
