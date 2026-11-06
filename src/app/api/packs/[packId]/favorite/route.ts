/**
 * 收藏 / 取消收藏整合包（关联包本身，不随版本失效；`idea.md` §15）。
 *
 * POST /api/packs/{packId}/favorite  → { favorited: boolean }
 *
 * 走 interactions 的 `toggleFavorite`（收藏的唯一真源）。以前走 packs 模块的
 * `togglePackFavorite`，它读写旧表 `plugin_pack_favorites`，而 /me/favorites/packs
 * 读新表 `pack_favorites` —— 详情页收藏了、新收藏页看不到（交接文档 §6.4）。
 * packs 模块的同名方法现在也只是转发到这里，保留是为了不打断既有调用点与测试。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createInteractionsService } from '@/server/modules/interactions';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ packId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { packId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const service = createInteractionsService({ db: getDb() });
    const result = await service.toggleFavorite(ctx, { kind: 'pack', targetId: packId });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
