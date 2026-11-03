/**
 * 单条草稿：GET / PATCH / DELETE /api/forum/drafts/{draftId}
 *
 * POST 到本路由表示"发布"：把草稿内容搬成正式帖子，成功即删草稿。
 * 发布走与直接发帖完全相同的服务（权限、归档判定、自动审核、附件规则），
 * 不另写一套，避免两条路径的规则漂移。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createForumDraftService } from '@/server/modules/forum/drafts';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ draftId: string }> }): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const { draftId } = await context.params;
    const service = createForumDraftService({ db: getDb() });
    return okJson(await service.getDraft(ctx, draftId), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ draftId: string }> }): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const { draftId } = await context.params;
    const body = (await readJson(request)) as {
      boardId?: unknown;
      title?: unknown;
      bodyMd?: unknown;
      fileIds?: unknown;
    };
    const service = createForumDraftService({ db: getDb() });
    const result = await service.saveDraft(ctx, {
      draftId,
      boardId: typeof body.boardId === 'string' ? body.boardId : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      bodyMd: typeof body.bodyMd === 'string' ? body.bodyMd : undefined,
      fileIds: body.fileIds,
    });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ draftId: string }> }): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const { draftId } = await context.params;
    const service = createForumDraftService({ db: getDb() });
    await service.deleteDraft(ctx, draftId);
    return okJson({ deleted: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 发布草稿。频控与直接发帖同一个口径：发布也是一次发帖。 */
export async function POST(request: Request, context: { params: Promise<{ draftId: string }> }): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const { draftId } = await context.params;
    const db = getDb();
    const draftService = createForumDraftService({ db });
    const postService = createForumPostService({ db });

    // 先读草稿：不存在或不是本人的，直接 400，不浪费频控额度
    const draft = await draftService.getDraft(ctx, draftId);

    const ticket = await enforceRateLimit(db, 'forum_post', ctx.userId, 1, await rateLimitOverrideFor(db, RATE_LIMIT_RULES.forum_post));
    try {
      const result = await postService.createPost(ctx, {
        boardSlug: draft.boardSlug,
        title: draft.title,
        bodyMd: draft.bodyMd,
        fileIds: draft.fileIds,
      });
      // 帖子已经落地，草稿留着反而让人以为没发出去
      await draftService.deleteDraft(ctx, draftId);
      return okJson(result, requestId, 201);
    } catch (e) {
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
