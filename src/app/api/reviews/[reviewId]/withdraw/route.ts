/**
 * 作者撤回评测（架构第 86 节）。
 *
 * POST /api/reviews/{reviewId}/withdraw
 *
 * 作者从本人内容管理入口撤回自己的已发布评测：
 *  - 只有作者本人可以撤回（管理员走隐藏，不走撤回）；
 *  - 必须携带预期控制版本，避免旧页面撤回用户尚未查看的新内容；
 *  - 撤回不删除历史：公开修订指针保留，可见性由统一解析计算。
 */

import { getDb } from '@/server/platform/db';
import { contentService } from '@/server/modules/content';
import { reviewsService } from '@/server/modules/reviews';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { reviewId } = await params;
    const ctx = await currentContext();

    const body = (await readJson(request)) as {
      expectedControlVersion?: unknown;
      reason?: unknown;
      requestKey?: unknown;
      /** true = 撤回后同时删除作者草稿（可选，默认仅撤回）。 */
      deleteDraft?: unknown;
    };

    if (!Number.isInteger(body.expectedControlVersion)) {
      throw err.input('缺少预期控制版本。', [{ path: 'expectedControlVersion', message: '必须是整数' }]);
    }
    if (typeof body.requestKey !== 'string' || body.requestKey.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }

    const result = await contentService.withdraw(
      ctx,
      {
        reviewId,
        expectedControlVersion: body.expectedControlVersion as number,
        reason: typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason : null,
        requestKey: body.requestKey,
      },
      getDb(),
    );

    // 撤回已经生效；删除草稿是可选的后置动作。草稿不存在时按「没有草稿可删」处理，
    // 不把撤回结果变成失败。
    let draftDeleted = false;
    if (body.deleteDraft === true) {
      const deleted = await reviewsService.deleteDraftByReview(ctx, reviewId, getDb());
      draftDeleted = deleted.deleted;
    }

    return okJson({ withdrawnAt: result.withdrawnAt, draftDeleted }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
