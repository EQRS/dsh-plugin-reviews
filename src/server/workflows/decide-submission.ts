/**
 * 审核决定流程（架构第 90 节）。
 *
 * 职责：把「管理员人工决定 → （通过时）**入队发布任务**」协调起来。
 *
 * ## 为什么必须有这个文件
 *
 * 在它之前，`POST /api/admin/submissions/{id}/decisions` 只调 `moderation.decideByAdmin`，
 * 把状态改成 `approved` 就结束了 —— **没有任何东西去发布**。
 * 真人点「通过」之后内容永远不公开，而两个验收脚本都在"通过"之后**直接调用 `publishReview`**，
 * 把这条缝盖住了：单测全绿、验收全绿，页面上的主路径却是断的。
 * 这与"worker handlers 是空注册表"是同一类问题（见 docs/README-切片说明.md §5）。
 *
 * worker 的 `review_check` 处理器在**自动检查通过**时会入队 `review_publish`
 * （见 `src/worker/handlers.ts`）。人工通过是另一条通向 `approved` 的路，
 * 它必须做同一件事，否则"人工审核"这条产品路径根本不成立。
 *
 * ## 幂等
 *
 * 去重键与 worker **完全一致**（`<publish_task_type>:<submissionId>`）：
 * 无论"检查自动通过"还是"管理员人工通过"先发生，队列里都只有一条发布任务。
 * `publishReview` / `publishComment` 自身对已发布的提交返回 `already_published`，
 * 不会重复切换修订指针。
 *
 * ## 提交类型决定发布任务类型
 *
 * 后台待办里混着**两类**提交：评测（`review_revision`）与评论（`comment_revision`），
 * 评论提交同样会落 `manual_review`。所以这里必须按 `submission_type` 选任务类型 ——
 * 一律入队 `review_publish` 的话，被管理员通过的评论会静默地永远发不出去（不报错，只是没人处理）。
 * 这条是浏览器验收时真踩出来的：点"通过"一条评论提交，评论始终不出现在讨论组里。
 *
 * ## 入队位置
 *
 * 放在决定事务**提交之后**，与 `submit-review.ts` 同构：better-sqlite3 的事务回调
 * 必须同步，而 tasks 的加载是异步的。这条偏离在 `docs/模块签名契约.md` §9.2 有记录。
 */

import { getDb, type SqliteDatabase } from '@/server/platform/db';
import { nowMs } from '@/server/platform/time';
import type { CallerContext } from '@/server/platform/context';
import { createModerationService } from '@/server/modules/moderation';
import type { SubmissionState } from '@/packages/common/field-rules';
import { loadTasks } from './submit-review';

export interface DecideSubmissionInput {
  submissionId: string;
  decision: 'approve' | 'needs_changes';
  /** 处理原因，必填（由路由层校验后传入，模块不重复校验）。 */
  reason: string;
  expectedStateVersion: number;
  requestKey: string;
}

export interface DecideSubmissionResult {
  state: SubmissionState;
  /**
   * 通过时入队的发布任务 ID；`needs_changes`、或 tasks 模块不可用时为 null。
   * 为 null 时**不是成功**：调用方必须如实告诉管理员"通过了但没人去发布"。
   */
  publishTaskId: string | null;
}

export async function decideSubmission(
  ctx: CallerContext,
  input: DecideSubmissionInput,
  db: SqliteDatabase = getDb(),
): Promise<DecideSubmissionResult> {
  const moderation = createModerationService(db);
  const decided = await moderation.decideByAdmin(ctx, {
    submissionId: input.submissionId,
    decision: input.decision,
    reason: input.reason,
    expectedStateVersion: input.expectedStateVersion,
    requestKey: input.requestKey,
  });

  // 只有"通过"才需要发布；"需修改"停在 needs_changes，等作者改完重新提交。
  if (decided.state !== 'approved') {
    return { state: decided.state, publishTaskId: null };
  }

  // 发布任务的类型必须**按提交类型**选：后台待办里混着"评测提交"和"评论提交"
  // （评论提交同样会落 manual_review）。一律入队 review_publish 的话，
  // 被通过的那条评论永远发不出去 —— 而且不会报错，只是静默地没人处理。
  // 去重键与 worker 的 check 处理器构造方式保持一致（`<type>:<submissionId>`）。
  const typeRow = db
    .prepare('SELECT submission_type FROM content_submissions WHERE id = ?')
    .get(input.submissionId) as { submission_type: string } | undefined;
  const publishTaskType = typeRow?.submission_type === 'comment_revision' ? 'comment_publish' : 'review_publish';

  const tasks = await loadTasks(db);
  if (!tasks) return { state: decided.state, publishTaskId: null };

  const res = await tasks.enqueue({
    taskType: publishTaskType,
    deduplicationKey: `${publishTaskType}:${input.submissionId}`,
    requestedBy: ctx.userId,
    payload: { submission_id: input.submissionId },
    schedulingGroup: publishTaskType,
    availableAt: nowMs(),
    tx: db,
  });

  return { state: decided.state, publishTaskId: res.taskId };
}
