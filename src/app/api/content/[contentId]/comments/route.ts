/**
 * 评论接口（架构第 78、79 节）。
 *
 * POST /api/content/{contentId}/comments   提交新评论或回复
 * GET  /api/content/{contentId}/comments   公开顶层讨论组分页
 *
 * 公开读取只在**目标当前公开**时返回内容；正文取自当前公开修订。
 */

import { getDb } from '@/server/platform/db';
import { commentsService } from '@/server/modules/comments';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { err } from '@/packages/common/errors';
import { PaginationDefaults } from '@/packages/common/result';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

/**
 * 页码/每页校验。**导出**是给同级的 `.../comments/[commentId]/replies` 复用 ——
 * 允许的每页条数是产品规则，复制两份迟早漂移。
 */
export function parsePaging(url: URL): { page: number; pageSize: number } {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('page_size') ?? String(PaginationDefaults.default_page_size));
  if (!Number.isInteger(page) || page < 1) {
    throw err.input('页码必须是从 1 开始的正整数。', [{ path: 'page', message: '取值不合法' }]);
  }
  if (!(PaginationDefaults.allowed_page_sizes as readonly number[]).includes(pageSize)) {
    throw err.input(`每页条数只允许 ${PaginationDefaults.allowed_page_sizes.join('、')}。`, [
      { path: 'page_size', message: '取值不合法' },
    ]);
  }
  return { page, pageSize };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ contentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { contentId } = await params;
    const { page, pageSize } = parsePaging(new URL(request.url));
    const db = getDb();

    // 目标不公开 → 不返回正文与讨论（架构第 79.3 节）。
    const vis = resolveVisibilityInTx(db, contentId);
    if (!vis.publiclyVisible) throw err.unavailable('该内容当前不可查看。');

    const result = await commentsService.listRootComments(contentId, { page, page_size: pageSize }, db);
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ contentId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { contentId } = await params;
    const ctx = await currentContext();
    const body = (await readJson(request)) as {
      body?: unknown;
      replyToCommentId?: unknown;
      requestKey?: unknown;
    };

    if (typeof body.body !== 'string' || typeof body.requestKey !== 'string') {
      throw err.input('缺少评论正文或请求标识。', [
        { path: 'body', message: '必填' },
        { path: 'requestKey', message: '必填' },
      ]);
    }

    const db = getDb();
    const vis = resolveVisibilityInTx(db, contentId);
    if (!vis.publiclyVisible) throw err.unavailable('该内容当前不可评论。');

    const result = await commentsService.createComment(
      ctx,
      {
        contentEntityId: contentId,
        body: body.body,
        replyToCommentId: typeof body.replyToCommentId === 'string' ? body.replyToCommentId : null,
        requestKey: body.requestKey,
      },
      db,
    );
    return okJson(result, requestId, 202);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
