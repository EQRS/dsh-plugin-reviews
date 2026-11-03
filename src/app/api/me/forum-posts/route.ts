/** 我的帖子：GET /api/me/forum-posts?status=published|deleted&page=1 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createForumPostService } from '@/server/modules/forum/posts';
import type { ForumContentStatus } from '@/packages/common/forum';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const url = new URL(request.url);
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const rawStatus = url.searchParams.get('status');
    const status: ForumContentStatus = rawStatus === 'deleted' ? 'deleted' : 'published';
    const service = createForumPostService({ db: getDb() });
    return okJson(await service.listMine(ctx, { page: Number.isFinite(page) ? page : 1, status }), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
