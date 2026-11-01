/** 单期精选（公开；草稿仅管理员可见）。GET /api/featured/12 */

import { getDb } from '@/server/platform/db';
import { createFeaturedService } from '@/server/modules/featured';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ issue: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { issue } = await params;
    const issueNumber = Number.parseInt(issue, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw err.input('期号不合法。', [{ path: 'issue', message: '正整数' }]);
    }
    const ctx = await currentContext();
    const service = createFeaturedService({ db: getDb() });
    return okJson(await service.getPublished(ctx, issueNumber), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
