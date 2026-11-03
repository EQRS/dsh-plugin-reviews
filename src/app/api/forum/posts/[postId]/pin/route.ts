/** 置顶切换：POST /api/forum/posts/{postId}/pin  { pinned: boolean } */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createForumPostService } from '@/server/modules/forum/posts';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    const { postId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const body = (await readJson(request)) as { pinned?: unknown };
    if (typeof body.pinned !== 'boolean') {
      throw err.input('pinned 必须是 true 或 false。', [{ path: 'pinned', message: '类型不合法' }]);
    }
    const service = createForumPostService({ db: getDb() });
    await service.setPinned(ctx, postId, body.pinned);
    return okJson({ pinned: body.pinned }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
