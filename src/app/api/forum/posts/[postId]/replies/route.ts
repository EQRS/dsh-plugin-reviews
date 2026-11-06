/**
 * 回复列表与发表回复。
 *
 * GET  /api/forum/posts/{postId}/replies   两层结构（顶层带 children）
 * POST /api/forum/posts/{postId}/replies   { bodyMd, parentId?, attachmentIds? }
 *
 * attachmentIds 可传 attachments.id 或 attachment_files.id（服务端统一解析）；
 * 旧字段名 fileIds 仍接受。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta, readJson, assertForumEnabled } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
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
    assertForumEnabled();
    const { postId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as {
      bodyMd?: unknown;
      parentId?: unknown;
      attachmentIds?: unknown;
      /** @deprecated 旧字段名，等价于 attachmentIds。 */
      fileIds?: unknown;
    };
    const db = getDb();
    const ticket = await enforceRateLimit(db, 'forum_reply', ctx.userId, 1, await rateLimitOverrideFor(db, RATE_LIMIT_RULES.forum_reply));
    try {
      const service = createForumPostService({ db });
      const result = await service.createReply(ctx, postId, {
        bodyMd: body.bodyMd,
        parentId: body.parentId,
        attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : undefined,
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
