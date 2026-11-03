/**
 * 我的草稿：GET /api/forum/drafts
 *
 * 只列本人的草稿；别人的草稿一律不可见（不区分"没有"与"不是你的"）。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createForumDraftService } from '@/server/modules/forum/drafts';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const service = createForumDraftService({ db: getDb() });
    return okJson(await service.listMine(ctx), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/**
 * 保存草稿：POST /api/forum/drafts  { draftId?, boardId?, title?, bodyMd?, fileIds? }
 * 带 draftId 为更新，不带为新建。标题与正文都允许为空——写一半很正常。
 */

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const body = (await readJson(request)) as {
      draftId?: unknown;
      boardId?: unknown;
      title?: unknown;
      bodyMd?: unknown;
      fileIds?: unknown;
    };
    const service = createForumDraftService({ db: getDb() });
    const result = await service.saveDraft(ctx, {
      draftId: typeof body.draftId === 'string' ? body.draftId : undefined,
      boardId: typeof body.boardId === 'string' ? body.boardId : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      bodyMd: typeof body.bodyMd === 'string' ? body.bodyMd : undefined,
      fileIds: body.fileIds,
    });
    return okJson(result, requestId, result.created ? 201 : 200);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
