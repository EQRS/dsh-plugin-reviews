/**
 * 发帖：POST /api/forum/posts  { boardSlug, title, bodyMd, fileIds? }
 *
 * 频控走 rate_limits.forum_post_per_hour（后台可调）。
 * 鉴权先于读 body：匿名用户不该先拿到「参数错误」。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createForumPostService } from '@/server/modules/forum/posts';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as {
      boardSlug?: unknown;
      title?: unknown;
      bodyMd?: unknown;
      fileIds?: unknown;
    };
    if (typeof body.boardSlug !== 'string' || body.boardSlug.length === 0) {
      throw err.input('缺少分区。', [{ path: 'boardSlug', message: '必填' }]);
    }

    const db = getDb();
    const ticket = await enforceRateLimit(db, 'forum_post', ctx.userId, 1, await rateLimitOverrideFor(db, RATE_LIMIT_RULES.forum_post));
    try {
      const service = createForumPostService({ db });
      const result = await service.createPost(ctx, {
        boardSlug: body.boardSlug,
        title: body.title,
        bodyMd: body.bodyMd,
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
