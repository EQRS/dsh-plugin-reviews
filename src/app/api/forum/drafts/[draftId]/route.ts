/**
 * 单条草稿：GET / PATCH / DELETE /api/forum/drafts/{draftId}
 *
 * POST 到本路由表示"发布"：把草稿内容搬成正式帖子，成功即删草稿。
 * 发布走与直接发帖完全相同的服务（权限、归档判定、自动审核、附件规则），
 * 不另写一套，避免两条路径的规则漂移。
 */

import { getDb } from '@/server/platform/db';
import { withTransaction } from '@/server/platform/tx';
import { assertCanWrite } from '@/server/platform/context';
import { enforceRateLimit, refundQuietly, RATE_LIMIT_RULES } from '@/server/platform/rate-limit';
import { rateLimitOverrideFor } from '@/server/modules/settings';
import { createForumDraftService, deleteDraftInTx } from '@/server/modules/forum/drafts';
import { createForumPostService } from '@/server/modules/forum/posts';
import { currentContext, okJson, errorResponse, requestMeta, readJson, assertForumEnabled } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ draftId: string }> }): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
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
    assertForumEnabled();
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const { draftId } = await context.params;
    const body = (await readJson(request)) as {
      boardId?: unknown;
      title?: unknown;
      bodyMd?: unknown;
      attachmentIds?: unknown;
      /** @deprecated 旧字段名，等价于 attachmentIds。 */
      fileIds?: unknown;
    };
    const service = createForumDraftService({ db: getDb() });
    const result = await service.saveDraft(ctx, {
      draftId,
      boardId: typeof body.boardId === 'string' ? body.boardId : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      bodyMd: typeof body.bodyMd === 'string' ? body.bodyMd : undefined,
      attachmentIds: body.attachmentIds,
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
    assertForumEnabled();
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
    assertForumEnabled();
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
      // 建帖与删草稿在**同一个事务**里：此前是两个独立提交，帖子写进去之后
      // 删草稿失败会回 500，用户重试就发出第二篇一模一样的帖子。
      // 现在一起回滚，重试是安全的（帖子与草稿要么都在、要么都不在）。
      //
      // 注意 withTransaction 的回调必须是同步函数，而两个服务方法都是 async——
      // 所以这里直接调它们的同步内核（postService.createPostInTx / deleteDraftInTx），
      // 与外层事务共用同一个连接，绝不嵌套 withTransaction。
      const result = withTransaction((tx) => {
        const created = postService.createPostInTx(tx.db, ctx, {
          boardSlug: draft.boardSlug,
          title: draft.title,
          bodyMd: draft.bodyMd,
          fileIds: draft.fileIds,
        });
        deleteDraftInTx(tx.db, draftId, ctx.userId ?? '');
        return created;
      }, db);
      return okJson(result, requestId, 201);
    } catch (e) {
      await refundQuietly(ticket);
      throw e;
    }
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
