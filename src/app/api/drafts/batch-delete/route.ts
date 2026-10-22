/**
 * 批量删除草稿：POST /api/drafts/batch-delete
 *
 * 语义与单删一致：已发布的评测在删除草稿时一并撤回；全部在一个事务里完成。
 */
import { getDb } from '@/server/platform/db';
import { reviewsService } from '@/server/modules/reviews';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { draftIds?: unknown };
    if (!Array.isArray(body.draftIds) || body.draftIds.some((id) => typeof id !== 'string')) {
      throw err.input('draftIds 必须是草稿标识数组。', [{ path: 'draftIds', message: '类型不正确' }]);
    }
    const result = await reviewsService.deleteDrafts(ctx, body.draftIds as string[], getDb());
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
