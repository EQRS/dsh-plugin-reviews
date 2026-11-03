/**
 * 分区申请：POST 提交 / GET 我的申请。
 *
 * 频控走 rate_limits.forum_board_application_per_day。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createForumBoardApplicationService } from '@/server/modules/forum/applications';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const service = createForumBoardApplicationService({ db: getDb() });
    return okJson({ items: await service.listMine(ctx) }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const body = await readJson(request);

    const db = getDb();
    const ticket = await enforceRateLimit(
      db,
      'forum_board_application',
      ctx.userId,
      1,
      await rateLimitOverrideFor(db, RATE_LIMIT_RULES.forum_board_application),
    );
    try {
      const service = createForumBoardApplicationService({ db });
      return okJson(await service.submit(ctx, body), requestId, 201);
    } catch (e) {
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
