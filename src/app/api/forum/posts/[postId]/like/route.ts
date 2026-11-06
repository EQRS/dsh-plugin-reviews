/** 帖子点赞切换：POST /api/forum/posts/{postId}/like */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta, assertForumEnabled } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const { postId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const service = createForumPostService({ db: getDb() });
    return okJson(await service.togglePostLike(ctx, postId), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
