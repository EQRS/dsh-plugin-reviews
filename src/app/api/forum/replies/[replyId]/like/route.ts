/** 顶层回复点赞切换：POST /api/forum/replies/{replyId}/like（回复的回复会 400）。 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ replyId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    const { replyId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const service = createForumPostService({ db: getDb() });
    return okJson(await service.toggleReplyLike(ctx, replyId), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
