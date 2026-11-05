/**
 * 帖子详情：GET /api/forum/posts/{id}
 * 编辑：PATCH /api/forum/posts/{id}  { title, bodyMd }
 * 软删：DELETE /api/forum/posts/{id}
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta, readJson, assertForumEnabled } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const { postId } = await params;
    const ctx = await currentContext();
    const service = createForumPostService({ db: getDb() });
    return okJson(await service.getPost(ctx, postId), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const { postId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const body = (await readJson(request)) as { title?: unknown; bodyMd?: unknown };
    const service = createForumPostService({ db: getDb() });
    await service.editPost(ctx, postId, { title: body.title, bodyMd: body.bodyMd });
    return okJson({ updated: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const { postId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const service = createForumPostService({ db: getDb() });
    await service.deletePost(ctx, postId);
    return okJson({ deleted: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
