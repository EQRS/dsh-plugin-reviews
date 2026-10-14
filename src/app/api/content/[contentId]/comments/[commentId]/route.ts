/**
 * 单条评论接口（`idea.md §11`：用户可改自己评论、可删自己评论）。
 *
 * PUT    /api/content/{contentId}/comments/{commentId}   修改自己的评论（同套检查后替换）
 * DELETE /api/content/{contentId}/comments/{commentId}   删除自己的评论（软删除，有回复保留占位）
 *
 * 两个刻意的取舍：
 *  1. **修改要过频控**（与新建评论同一个桶，规格第 24 行："新评论、回复、正文修改合并计数"）；
 *  2. **删除不挂频控**：它天然只可能成功一次（删了就删了，没有"恢复"接口），
 *     重放返回 alreadyDeleted 且不产生变更，没有可被刷的放大面。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { commentsService } from '@/server/modules/comments';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ contentId: string; commentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { contentId, commentId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as { body?: unknown; requestKey?: unknown };
    if (typeof body.body !== 'string' || typeof body.requestKey !== 'string') {
      throw err.input('缺少评论正文或请求标识。', [
        { path: 'body', message: '必填' },
        { path: 'requestKey', message: '必填' },
      ]);
    }

    const db = getDb();
    // 讨论不可见时不允许改（撤回/隐藏的内容不该还能编辑其中的讨论）。
    const vis = resolveVisibilityInTx(db, contentId);
    if (!vis.publiclyVisible) throw err.unavailable('该内容当前不可修改评论。');

    // assertCanWrite 同时把 ctx.userId 收窄成 string（频控需要非空用户标识），
    // 与新建评论那条路由保持同一套前置。
    assertCanWrite(ctx);
    const ticket = await enforceRateLimit(
      db,
      'comment_change',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.comment_change),
    );
    try {
      const result = await commentsService.editComment(
        ctx,
        { commentId, body: body.body, requestKey: body.requestKey },
        db,
      );
      // 幂等重放不另算一次提交（与新建同规则）→ 退还额度。
      if (result.created === false) await refundQuietly(ticket);
      return okJson(
        {
          commentId: result.commentId,
          revisionId: result.revisionId,
          submissionId: result.submissionId,
          created: result.created,
        },
        requestId,
        202,
      );
    } catch (e) {
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ contentId: string; commentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    // contentId 在路径里是定位用的；真正的权限判据是"这条评论是不是你的"（服务层在事务内核验）。
    // 这里只要求登录：内容被撤回后，作者仍应能删掉自己说过的话。
    const { commentId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const db = getDb();
    const result = await commentsService.deleteComment(ctx, { commentId }, db);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
