/**
 * 标记通知已读（`idea.md §11`：顶部未读数）。
 *
 * POST /api/me/notifications/read
 *   { "ids": ["...","..."] }  → 只标记这些（别人的 id 会被 SQL 的 recipient 条件挡住）
 *   { "all": true }           → 全部标记已读
 *
 * **不需要请求键**：标记已读天然幂等（第二次调用 changes=0，不会产生副作用），
 * 规格里要求请求键的是"会产生新记录"的写入。这个判断写在注释里，免得后来人以为漏了。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createNotificationsService } from '@/server/modules/notifications';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);

    const body = (await readJson(request)) as { ids?: unknown; all?: unknown };
    const all = body.all === true;
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : undefined;
    if (!all && (ids === undefined || ids.length === 0)) {
      throw err.input('要么给 ids，要么给 all: true。', [{ path: 'ids', message: '不能为空' }]);
    }
    if (ids !== undefined && ids.length > 100) {
      throw err.input('一次最多标记 100 条。', [{ path: 'ids', message: '一次最多 100 条' }]);
    }

    const service = createNotificationsService({ db: getDb() });
    const result = await service.markRead(ctx.userId, all ? { all: true } : { ids });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
