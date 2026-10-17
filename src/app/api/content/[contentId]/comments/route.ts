/**
 * 评论接口（架构第 78、79 节）。
 *
 * POST /api/content/{contentId}/comments   提交新评论或回复
 * GET  /api/content/{contentId}/comments   公开顶层讨论组分页
 *
 * 公开读取只在**目标当前公开**时返回内容；正文取自当前公开修订。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { commentsService } from '@/server/modules/comments';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { err } from '@/packages/common/errors';
import { parsePaging } from '@/app/api/_lib/pagination';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ contentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { contentId } = await params;
    const { page, pageSize } = parsePaging(new URL(request.url));
    const db = getDb();

    // 目标不公开 → 不返回正文与讨论（架构第 79.3 节）。
    const vis = resolveVisibilityInTx(db, contentId);
    if (!vis.publiclyVisible) throw err.unavailable('该内容当前不可查看。');

    const result = await commentsService.listRootComments(contentId, { page, page_size: pageSize }, db);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ contentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { contentId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as {
      body?: unknown;
      replyToCommentId?: unknown;
      requestKey?: unknown;
    };

    if (typeof body.body !== 'string' || typeof body.requestKey !== 'string') {
      throw err.input('缺少评论正文或请求标识。', [
        { path: 'body', message: '必填' },
        { path: 'requestKey', message: '必填' },
      ]);
    }

    const db = getDb();
    const vis = resolveVisibilityInTx(db, contentId);
    if (!vis.publiclyVisible) throw err.unavailable('该内容当前不可评论。');

    // 频控（参数与管理规则.md 第 24 行）：新评论 / 回复 / 正文修改**合并计数**，每分钟 5 次。
    // 本路由是评论唯一的写入入口（回复也走这里，用 replyToCommentId 区分），所以挂一处即可。
    // 上限可后台调（modules/settings），默认值仍是 5/分。
    assertCanWrite(ctx);
    const ticket = await enforceRateLimit(
      db,
      'comment_change',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.comment_change),
    );

    try {
      const result = await commentsService.createComment(
        ctx,
        {
          contentEntityId: contentId,
          body: body.body,
          replyToCommentId: typeof body.replyToCommentId === 'string' ? body.replyToCommentId : null,
          requestKey: body.requestKey,
        },
        db,
      );
      // 幂等重放（同作者同 requestKey 复用既有提交）不另算一次提交 → 退还额度。
      if (result.created === false) await refundQuietly(ticket);
      return okJson(result, requestId, 202);
    } catch (e) {
      // 未产生任何变更 → 不占用业务额度（无效输入由独立的请求层防护，见规格第 27 行）。
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
