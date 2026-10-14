/**
 * 任务队列服务（工作包 GT）。
 *
 * 权威依据：
 *  - docs/模块签名契约.md 第 7 节（签名）与第 176-177 行（参数）；
 *  - migrations/0001_baseline.sql §3.6（表结构与 CHECK）；
 *  - migrations/0002_triggers.sql 第 225-231 行（已结束的 attempt 不可改写）。
 *
 * 核心不变量（并行工作包 §2.9）：
 *   **执行权 CAS**：续期、写回、结束都必须校验 `execution_token` **且**
 *   `lease_expires_at > now`。旧进程晚到的写回必须被拒绝。
 *
 * 因此本模块里**每一条**碰任务状态的 UPDATE 都带
 *   `WHERE id = ? AND execution_token = ? AND processing_state = 'running' AND lease_expires_at > ?`
 * 并检查 `changes === 1`。少写任何一项，对应用例都会变红。
 */

import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { withTransaction } from '@/server/platform/tx';
import type { Tx } from '@/server/platform/tx';
import { newId, newOpaqueToken } from '@/server/platform/id';
import { nowMs } from '@/server/platform/time';
import type { TaskState, TaskType } from '@/packages/common/field-rules';
import { err } from '@/packages/common/errors';
import {
  LEASE_DURATION_MS,
  MAX_RECOVERABLE_ATTEMPTS,
  TASK_DEADLINE_MS,
  nextAvailableAt,
} from './constants';

export * from './constants';

/** 领取到手的执行权。executionToken 是唯一写回凭据。 */
export interface ClaimedTask {
  taskId: string;
  taskType: TaskType;
  executionToken: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  attemptNumber: number;
  retryCycle: number;
  payload: unknown;
  schedulingGroup: string;
  deadlineAt: number;
}

export interface TasksService {
  enqueue(input: {
    taskType: TaskType;
    deduplicationKey: string;
    requestedBy: string | null;
    payload: unknown;
    schedulingGroup: string;
    availableAt: number;
    tx?: unknown;
  }): Promise<{ taskId: string; created: boolean }>;
  claim(workerReference: string, now: number): Promise<ClaimedTask | null>;
  renew(claim: { taskId: string; executionToken: string }, now: number): Promise<boolean>;
  finish(
    claim: { taskId: string; executionToken: string },
    input: {
      outcome: 'success' | 'error' | 'skipped';
      errorCode?: string;
      errorSummary?: string;
      /** 结构化结果，写进 `background_tasks.progress`（后台页展示"这一轮干了什么"）。不传则保留原值。 */
      progress?: unknown;
      now: number;
    },
  ): Promise<void>;
  recoverExpired(now: number): Promise<number>;
}

interface TaskRow {
  id: string;
  task_type: TaskType;
  processing_state: TaskState;
  available_at: number;
  attempt_count: number;
  retry_cycle: number;
  cycle_attempt_count: number;
  execution_token: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  payload: string;
}

/** 事务句柄可能是 platform Tx、裸连接，或调用方未传（则本模块自开事务）。 */
function resolveDb(tx: unknown): SqliteDatabase | null {
  if (!tx || typeof tx !== 'object') return null;
  const candidate = tx as { db?: unknown };
  if (candidate.db && typeof candidate.db === 'object') return candidate.db as SqliteDatabase;
  // 允许直接传裸连接（Tx 与 SqliteDatabase 都以 .db / .prepare 暴露语句能力）。
  const direct = tx as { prepare?: unknown };
  if (typeof direct.prepare === 'function') return tx as SqliteDatabase;
  return null;
}

function isSqliteDatabase(value: unknown): value is SqliteDatabase {
  return typeof (value as { prepare?: unknown } | null)?.prepare === 'function';
}

function mapClaim(row: TaskRow, workerReference: string, token: string, now: number, attemptNumber: number): ClaimedTask {
  return {
    taskId: row.id,
    taskType: row.task_type,
    executionToken: token,
    leaseOwner: workerReference,
    leaseExpiresAt: now + LEASE_DURATION_MS,
    attemptNumber,
    retryCycle: row.retry_cycle,
    payload: JSON.parse(row.payload) as unknown,
    schedulingGroup: '',
    deadlineAt: now + TASK_DEADLINE_MS,
  };
}

/** 短事务内完成的领取实现。 */
function claimWithin(db: SqliteDatabase, workerReference: string, now: number): ClaimedTask | null {
  // 取一条可执行任务。queued 或 retry_wait 且已到可执行时刻。
  // 用 UPDATE ... WHERE id = (SELECT ...) RETURNING 保证「选中 + 占用」原子完成，
  // 并发第二个 worker 会在同一事务里看不到（或改不到）这一行。
  const token = newOpaqueToken();

  const selected = db
    .prepare(
      `SELECT id, task_type, processing_state, available_at, attempt_count, retry_cycle,
              cycle_attempt_count, execution_token, lease_owner, lease_expires_at, payload
         FROM background_tasks
        WHERE processing_state IN ('queued','retry_wait')
          AND available_at <= ?
        ORDER BY available_at ASC, created_at ASC, id ASC
        LIMIT 1`,
    )
    .get(now) as TaskRow | undefined;

  if (!selected) return null;

  // 原子占用：只有仍然是可执行态、且仍是我们在事务里看到的那一行时才成功。
  // `changes !== 1` 说明被别人抢先 → 本次领取失败（返回 null，不抛错）。
  const claimed = db
    .prepare(
      `UPDATE background_tasks
          SET processing_state = 'running',
              lease_owner = ?,
              lease_expires_at = ?,
              execution_token = ?,
              attempt_count = attempt_count + 1,
              cycle_attempt_count = cycle_attempt_count + 1,
              last_error_code = NULL,
              last_error_summary = NULL,
              updated_at = ?
        WHERE id = ?
          AND processing_state IN ('queued','retry_wait')
          AND available_at <= ?
          AND execution_token IS NULL`,
    )
    .run(workerReference, now + LEASE_DURATION_MS, token, now, selected.id, now);

  if (claimed.changes !== 1) return null;

  const attemptNumber = selected.attempt_count + 1;

  // 建执行记录。attempt_number 必须与任务上的递增一致（UNIQUE(task_id, attempt_number)）。
  db.prepare(
    `INSERT INTO background_task_attempts
       (id, task_id, attempt_number, retry_cycle, execution_token, worker_reference,
        config_snapshot, started_at, last_progress_at, deadline_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).run(
    newId(),
    selected.id,
    attemptNumber,
    selected.retry_cycle,
    token,
    workerReference,
    now,
    now,
    now + TASK_DEADLINE_MS,
  );

  return mapClaim(selected, workerReference, token, now, attemptNumber);
}

/** CAS 写回：所有状态变更都必须同时匹配 token + running + 未过期。 */
function casUpdate(
  db: SqliteDatabase,
  claim: { taskId: string; executionToken: string },
  now: number,
  build: (row: TaskRow) => {
    state: TaskState;
    availableAt?: number;
    errorCode?: string | null;
    errorSummary?: string | null;
    finishedAt?: number | null;
    clearLease: boolean;
  },
): { ok: boolean; row: TaskRow | null } {
  const row = db
    .prepare(
      `SELECT id, task_type, processing_state, available_at, attempt_count, retry_cycle,
              cycle_attempt_count, execution_token, lease_owner, lease_expires_at, payload
         FROM background_tasks WHERE id = ?`,
    )
    .get(claim.taskId) as TaskRow | undefined;

  if (!row) return { ok: false, row: null };

  const next = build(row);

  if (next.clearLease) {
    const result = db
      .prepare(
        `UPDATE background_tasks
            SET processing_state = ?,
                available_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                execution_token = NULL,
                last_error_code = ?,
                last_error_summary = ?,
                updated_at = ?,
                finished_at = ?
          WHERE id = ?
            AND execution_token = ?
            AND processing_state = 'running'
            AND lease_expires_at > ?`,
      )
      .run(
        next.state,
        next.availableAt ?? row.available_at,
        next.errorCode ?? null,
        next.errorSummary ?? null,
        now,
        next.finishedAt ?? null,
        claim.taskId,
        claim.executionToken,
        now,
      );
    return { ok: result.changes === 1, row };
  }

  const result = db
    .prepare(
      `UPDATE background_tasks
          SET processing_state = ?, available_at = ?, updated_at = ?
        WHERE id = ? AND execution_token = ? AND processing_state = 'running' AND lease_expires_at > ?`,
    )
    .run(next.state, next.availableAt ?? row.available_at, now, claim.taskId, claim.executionToken, now);
  return { ok: result.changes === 1, row };
}

export function createTasksService(db: SqliteDatabase): TasksService {
  return {
    /**
     * 入队。同 (task_type, deduplication_key) 复用既有任务。
     *
     * 幂等语义：唯一索引 `UNIQUE(task_type, deduplication_key)` 是权威判据。
     * 命中即返回原 taskId 且 created=false（不重置进度、不改状态）。
     */
    async enqueue(input) {
      if (!input.deduplicationKey || input.deduplicationKey.trim() === '') {
        throw err.input('去重键不能为空。', [{ path: 'deduplicationKey', message: '必填' }]);
      }
      if (!input.schedulingGroup || input.schedulingGroup.trim() === '') {
        throw err.input('调度组不能为空。', [{ path: 'schedulingGroup', message: '必填' }]);
      }
      if (!Number.isFinite(input.availableAt) || input.availableAt < 0) {
        throw err.input('availableAt 必须是合法的非负时刻。', [{ path: 'availableAt', message: '非法时刻' }]);
      }

      const outer = resolveDb(input.tx);
      const payloadJson = JSON.stringify(input.payload ?? null);

      const run = (handle: SqliteDatabase) => {
        const existing = handle
          .prepare('SELECT id FROM background_tasks WHERE task_type = ? AND deduplication_key = ?')
          .get(input.taskType, input.deduplicationKey) as { id: string } | undefined;
        if (existing) return { taskId: existing.id, created: false };

        const id = newId();
        const now = nowMs();
        handle
          .prepare(
            `INSERT INTO background_tasks
               (id, task_type, deduplication_key, requested_by, payload, scheduling_group,
                processing_state, available_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
          )
          .run(id, input.taskType, input.deduplicationKey, input.requestedBy, payloadJson, input.schedulingGroup, input.availableAt, now, now);
        return { taskId: id, created: true };
      };

      if (outer) return run(outer);
      // 无外部事务时自开一个短事务（调用方通常传业务事务进来，见契约 `tx?`）。
      return withTransaction((tx: Tx) => run(tx.db), db);
    },

    /** 原子领取。并发场景下只有一个 worker 能改到那一行。 */
    async claim(workerReference, now) {
      if (!workerReference || workerReference.trim() === '') {
        throw err.input('worker 标识不能为空。', [{ path: 'workerReference', message: '必填' }]);
      }
      // better-sqlite3 是同步驱动；db.transaction 会把整个回调包进一个事务。
      // 这里是「短事务」：只有一次 SELECT + 两次写，不做任何外部调用。
      const run = db.transaction(() => claimWithin(db, workerReference, now));
      return run();
    },

    /**
     * 续期。**必须**同时满足：token 匹配 + 仍 running + 租约未过期。
     * 任一不满足 → 返回 false 且**不改任何状态**。
     */
    async renew(claim, now) {
      const result = db
        .prepare(
          `UPDATE background_tasks
              SET lease_expires_at = ?, updated_at = ?
            WHERE id = ?
              AND execution_token = ?
              AND processing_state = 'running'
              AND lease_expires_at > ?`,
        )
        .run(now + LEASE_DURATION_MS, now, claim.taskId, claim.executionToken, now);

      if (result.changes !== 1) return false;

      // 同步推进 attempt 的进度心跳。已结束的记录不会被 UPDATE（触发器会 ABORT），
      // 因此这里只碰 outcome IS NULL 的行。
      db.prepare(
        `UPDATE background_task_attempts
            SET last_progress_at = ?
          WHERE execution_token = ? AND outcome IS NULL`,
      ).run(now, claim.executionToken);

      return true;
    },

    /**
     * 结束一次执行。
     *  - success  → succeeded（终态）
     *  - skipped  → skipped（终态）
     *  - error    → 未超上限：retry_wait（available_at = now + 等待序列）
     *               超上限：failed（终态）
     *
     * 所有写回都 CAS 校验 token + running + 未过期；校验失败抛 conflict，
     * 且**不动任何行**（连 attempt 也不动）。
     */
    async finish(claim, input) {
      const { now } = input;
      const run = db.transaction(() => {
        // 先把 CAS 条件核一遍：失败就整个事务回滚，attempt 保持原样。
        const live = db
          .prepare(
            `SELECT id, attempt_count, retry_cycle, cycle_attempt_count
               FROM background_tasks
              WHERE id = ? AND execution_token = ? AND processing_state = 'running' AND lease_expires_at > ?`,
          )
          .get(claim.taskId, claim.executionToken, now) as
          | { id: string; attempt_count: number; retry_cycle: number; cycle_attempt_count: number }
          | undefined;

        if (!live) {
          throw err.conflict('执行权已失效：该任务的租约已被顶替或过期，不能再写回。', {
            task_id: claim.taskId,
          });
        }

        let nextState: TaskState;
        let availableAt = now;
        let finishedAt: number | null = null;
        let errorCode: string | null = null;
        let errorSummary: string | null = null;
        let nextRetryCycle = live.retry_cycle;
        let nextCycleAttemptCount = live.cycle_attempt_count;
        // 结构化结果：给了才落盘（COALESCE 保留原值），序列化失败不让它把任务写回也搞挂。
        let progressJson: string | null = null;
        if (input.progress !== undefined) {
          try {
            progressJson = JSON.stringify(input.progress);
          } catch {
            progressJson = null;
          }
        }

        if (input.outcome === 'success') {
          nextState = 'succeeded';
          finishedAt = now;
        } else if (input.outcome === 'skipped') {
          // skipped 也可以带诊断码（例如 worker 报告 "no_handler"），
          // 否则"为什么被跳过"在库里查不到，只剩一个 outcome。
          nextState = 'skipped';
          finishedAt = now;
          errorCode = input.errorCode ?? null;
          errorSummary = input.errorSummary ?? null;
        } else {
          errorCode = input.errorCode ?? null;
          errorSummary = input.errorSummary ?? null;
          // 「普通可恢复故障最多 3 次」按**整条任务**累计（attempt_count 含本次已执行数），
          // 而不是每次等待后清零：清零会让预算永不耗尽，任务无限重试。
          // attempt_count 在 claim 时已自增，因此这里它 = 含本次的累计尝试数。
          const scheduled = nextAvailableAt(live.attempt_count, now);
          if (scheduled === null) {
            nextState = 'failed';
            finishedAt = now;
          } else {
            nextState = 'retry_wait';
            availableAt = scheduled;
            // 进入下一轮重试周期；cycle_attempt_count 记录**本周期内**的尝试数。
            nextRetryCycle = live.retry_cycle + 1;
            nextCycleAttemptCount = 0;
          }
        }

        const result = db
          .prepare(
            `UPDATE background_tasks
                SET processing_state = ?,
                    available_at = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    execution_token = NULL,
                    last_error_code = ?,
                    last_error_summary = ?,
                    -- 结构化结果（JSON 列，本来就是给它留的）：不传就保持原值，
                    -- 让后台页能直接看到"这一轮发现了什么"，而不是只能翻日志。
                    progress = COALESCE(?, progress),
                    updated_at = ?,
                    finished_at = ?,
                    retry_cycle = ?,
                    cycle_attempt_count = ?
              WHERE id = ?
                AND execution_token = ?
                AND processing_state = 'running'
                AND lease_expires_at > ?`,
          )
          .run(
            nextState,
            availableAt,
            errorCode,
            errorSummary,
            progressJson,
            now,
            finishedAt,
            nextRetryCycle,
            nextCycleAttemptCount,
            claim.taskId,
            claim.executionToken,
            now,
          );

        if (result.changes !== 1) {
          throw err.conflict('执行权已失效：写回被拒绝（状态已变化）。', { task_id: claim.taskId });
        }

        // 关掉 attempt：outcome 与 finished_at 必须同时写（表 CHECK 要求成对）。
        const attemptOutcome = input.outcome === 'success' ? 'success' : input.outcome === 'skipped' ? 'skipped' : 'error';
        db.prepare(
          `UPDATE background_task_attempts
              SET outcome = ?, finished_at = ?, error_code = ?, last_progress_at = ?
            WHERE execution_token = ? AND outcome IS NULL`,
        ).run(attemptOutcome, now, errorCode, now, claim.executionToken);
      });

      run();
    },

    /**
     * 到期恢复扫描：running 且 lease_expires_at <= now 的任务，
     * 把其 attempt 记 lease_expired，任务按重试预算回到 queued/retry_wait 或 failed。
     * 返回处理的**任务**条数。
     */
    async recoverExpired(now) {
      const run = db.transaction(() => {
        const expired = db
          .prepare(
            `SELECT id, execution_token, attempt_count, retry_cycle, cycle_attempt_count
               FROM background_tasks
              WHERE processing_state = 'running' AND lease_expires_at <= ?`,
          )
          .all(now) as {
          id: string;
          execution_token: string;
          attempt_count: number;
          retry_cycle: number;
          cycle_attempt_count: number;
        }[];

        let handled = 0;

        for (const task of expired) {
          // 租约到期同样消耗重试预算（它是一次失败的执行），所以按累计 attempt_count 判定。
          const scheduled = nextAvailableAt(task.attempt_count, now);
          const nextState: TaskState = scheduled === null ? 'failed' : 'retry_wait';
          const availableAt = scheduled ?? now;
          const finishedAt = scheduled === null ? now : null;

          const result = db
            .prepare(
              `UPDATE background_tasks
                  SET processing_state = ?,
                      available_at = ?,
                      lease_owner = NULL,
                      lease_expires_at = NULL,
                      execution_token = NULL,
                      last_error_code = 'lease_expired',
                      last_error_summary = '执行租约到期，任务被回收重新安排。',
                      updated_at = ?,
                      finished_at = ?,
                      retry_cycle = ?,
                      cycle_attempt_count = ?
                WHERE id = ?
                  AND processing_state = 'running'
                  AND execution_token = ?
                  AND lease_expires_at <= ?`,
            )
            .run(
              nextState,
              availableAt,
              now,
              finishedAt,
              scheduled === null ? task.retry_cycle : task.retry_cycle + 1,
              scheduled === null ? task.cycle_attempt_count : 0,
              task.id,
              task.execution_token,
              now,
            );

          if (result.changes !== 1) continue;

          // 旧执行记录保留（历史不可抹掉），只补结局。
          // 触发器 trg_attempts_no_rewrite_after_finish 会拦住对已结束记录的改写，
          // 所以这里只更新 outcome IS NULL 的那一条。
          db.prepare(
            `UPDATE background_task_attempts
                SET outcome = 'lease_expired', finished_at = ?, error_code = 'lease_expired', last_progress_at = ?
              WHERE execution_token = ? AND outcome IS NULL`,
          ).run(now, now, task.execution_token);

          handled += 1;
        }

        return handled;
      });

      return run();
    },
  };
}

/** 进程级单例（Web 与 worker 各一个进程，各自持有自己的连接）。 */
let singleton: TasksService | null = null;

export function tasksService(): TasksService {
  if (!singleton) singleton = createTasksService(getDb());
  return singleton;
}

/** 仅供测试与维护：重置单例。 */
export function resetTasksService(): void {
  singleton = null;
}

export { MAX_RECOVERABLE_ATTEMPTS, LEASE_DURATION_MS, TASK_DEADLINE_MS };
export type { TaskState, TaskType };
