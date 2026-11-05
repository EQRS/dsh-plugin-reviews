/** 删除回复：DELETE /api/forum/replies/{id}（软删）。 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta, assertForumEnabled } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function DELETE(request: Request, { params }: { params: Promise<{ replyId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const { replyId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const service = createForumPostService({ db: getDb() });
    await service.deleteReply(ctx, replyId);
    return okJson({ deleted: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
