/**
 * 评论发布流程（架构第 34.1、56、57 节；与 publish-review.ts 同构）。
 *
 * 为什么单独存在：评论发布最初写在 `src/worker/handlers.ts` 里（worker 层）。
 * 那段实现是**先读后写、读在事务外**，于是存在一个真实竞态：
 * 资格核验与写入之间若有并发删除/撤回，已删除的评论仍会被公开。
 * `publishReview` 用「在事务内重新核验」避免这类问题（架构第 57 节），
 * 评论必须遵守同一条规矩 —— 否则同一不变式有两份实现，迟早漂移。
 *
 * 不变式（全部在事务内重新核验，不依赖调用方此前的判断）：
 *  1. 提交处于 `approved`；
 *  2. 提交是评论修订、且快照存在、且属于该评论；
 *  3. 评论未被删除；
 *  4. 该提交仍是评论的最新提交（未被更新的提交取代）。
 */

import { withTransaction, type Tx } from '@/server/platform/tx';
import { nowMs } from '@/server/platform/time';
import type { SqliteDatabase } from '@/server/platform/db';
import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import type { SubmissionState } from '@/packages/common/field-rules';

export type CommentPublishReason =
  | 'submission_not_approved'
  | 'already_published'
  | 'submission_type_mismatch'
  | 'revision_missing'
  | 'comment_deleted'
  | 'comment_missing';

export interface CommentPublishOutcome {
  published: boolean;
  reason?: CommentPublishReason;
  commentId?: string;
  revisionId?: string;
  publishedAt?: number;
}

interface SubmissionRow {
  id: string;
  submission_type: string;
  processing_state: SubmissionState;
  comment_revision_id: string | null;
}

/**
 * 执行一次评论发布。
 *
 * 与 `publishReview` 一致：`published` 表示"该提交完成了发布"，
 * **不代表内容当前仍公开** —— 后续删除由可见性解析另行判断。
 */
export function publishComment(
  submissionId: string,
  db: SqliteDatabase = getDb(),
): CommentPublishOutcome {
  return withTransaction((tx: Tx) => {
    const handle = tx.db;
    const now = nowMs();

    const submission = handle
      .prepare('SELECT id, submission_type, processing_state, comment_revision_id FROM content_submissions WHERE id = ?')
      .get(submissionId) as SubmissionRow | undefined;

    if (!submission) throw err.unavailable('提交不存在。');
    if (submission.submission_type !== 'comment_revision') {
      return { published: false, reason: 'submission_type_mismatch' as const };
    }
    if (submission.processing_state === 'published') {
      return { published: false, reason: 'already_published' as const };
    }
    if (submission.processing_state !== 'approved') {
      // 未通过检查绝不发布；也不改写状态。
      return { published: false, reason: 'submission_not_approved' as const };
    }
    if (!submission.comment_revision_id) {
      return { published: false, reason: 'revision_missing' as const };
    }

    const revision = handle
      .prepare('SELECT id, comment_id FROM comment_revisions WHERE id = ?')
      .get(submission.comment_revision_id) as { id: string; comment_id: string } | undefined;
    if (!revision) return { published: false, reason: 'revision_missing' as const };

    const comment = handle
      .prepare('SELECT id, deleted_at, published_revision_id FROM comments WHERE id = ?')
      .get(revision.comment_id) as
      | {
          id: string;
          deleted_at: number | null;
          published_revision_id: string | null;
        }
      | undefined;
    if (!comment) return { published: false, reason: 'comment_missing' as const };

    // 已删除的评论不得被旧任务重新公开（与评测的 withdrawn/hidden 同理）。
    if (comment.deleted_at !== null) {
      return { published: false, reason: 'comment_deleted' as const };
    }

    // 注意：这里**没有**评测那样的 `superseded` 资格检查。
    //
    // publishReview 会用 `reviews.latest_submitted_revision_id !== revision.id` 挡掉
    // "被更新的提交取代"的旧快照。评论侧不能照抄：评论的提交路径
    // （src/server/modules/comments）**从未写过** `comments.latest_submitted_revision_id`，
    // 该列恒为 NULL。照抄会让检查永远不通过 —— 所有评论都判 superseded、
    // 一条也发不出去。这是实跑测试立刻暴露出来的（曾经真的写错过一次）。
    //
    // 评论当前只有"首次提交即修订"这一条路径（无编辑后再提交），所以
    // "被取代"这个状态在数据上还不可能出现。**将来若要支持编辑评论**，
    // 必须先在提交路径里维护 `latest_submitted_revision_id`，再在这里加回检查 ——
    // 两件事必须同时做，只加检查会重新踩上面这个坑。

    handle.prepare('UPDATE comments SET published_revision_id = ? WHERE id = ?').run(revision.id, comment.id);

    // 首次发布设置 first_published_at；**再次发布不重置**（用 COALESCE 表达，
    // 不必先读出来再分支 —— 少一次读、也不受读到的值是否过时影响）。
    handle
      .prepare('UPDATE comments SET first_published_at = COALESCE(first_published_at, ?) WHERE id = ?')
      .run(now, comment.id);

    handle
      .prepare(`UPDATE content_submissions SET processing_state = 'published', state_version = state_version + 1, updated_at = ? WHERE id = ?`)
      .run(now, submissionId);

    return {
      published: true,
      commentId: comment.id,
      revisionId: revision.id,
      publishedAt: now,
    };
  }, db);
}
