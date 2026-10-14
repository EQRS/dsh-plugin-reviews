/**
 * 站内通知（`idea.md §11`）。
 *
 * GET  /api/me/notifications            我的通知列表（含未读数）
 * GET  /api/me/notifications?unread_only=1&limit=20
 *
 * 已读操作在 `./read/route.ts`。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createNotificationsService } from '@/server/modules/notifications';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 用 assertCanWrite 而不是只判登录：它同时把 userId 收窄成 string，并保证账户是活跃的
    // （被禁用的账户不该继续读通知）。错误码与其它写接口一致。
    assertCanWrite(ctx);

    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unread_only') === '1';
    const limitRaw = Number(url.searchParams.get('limit') ?? '20');
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50) {
      throw err.input('limit 必须是 1..50 的整数。', [{ path: 'limit', message: '取值不合法' }]);
    }

    const service = createNotificationsService({ db: getDb() });
    const result = await service.list(ctx.userId, { limit: limitRaw, unreadOnly });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
