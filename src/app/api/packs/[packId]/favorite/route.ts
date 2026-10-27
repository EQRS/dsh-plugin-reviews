/**
 * 收藏 / 取消收藏整合包（关联包本身，不随版本失效；`idea.md` §15）。
 *
 * POST /api/packs/{packId}/favorite  → { favorited: boolean }
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createPacksService } from '@/server/modules/packs';
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
    const service = createPacksService({ db: getDb() });
    const result = await service.togglePackFavorite(ctx, packId);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
