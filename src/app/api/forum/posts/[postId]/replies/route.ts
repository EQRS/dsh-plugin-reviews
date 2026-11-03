/**
 * 回复列表与发表回复。
 *
 * GET  /api/forum/posts/{postId}/replies   两层结构（顶层带 children）
 * POST /api/forum/posts/{postId}/replies   { bodyMd, parentId?, fileIds? }
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    const { postId } = await params;
    const ctx = await currentContext();
    const service = createForumPostService({ db: getDb() });
    return okJson(await service.listReplies(ctx, postId), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    const { postId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as { bodyMd?: unknown; parentId?: unknown; fileIds?: unknown };
    const db = getDb();
    const ticket = await enforceRateLimit(db, 'forum_reply', ctx.userId, 1, await rateLimitOverrideFor(db, RATE_LIMIT_RULES.forum_reply));
    try {
      const service = createForumPostService({ db });
      const result = await service.createReply(ctx, postId, {
        bodyMd: body.bodyMd,
        parentId: body.parentId,
        fileIds: Array.isArray(body.fileIds) ? body.fileIds : undefined,
      });
      return okJson(result, requestId, 201);
    } catch (e) {
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
