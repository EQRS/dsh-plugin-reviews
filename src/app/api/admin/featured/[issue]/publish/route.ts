/** 发布一期。POST /api/admin/featured/12/publish  { expectedVersion } */

import { getDb } from '@/server/platform/db';
import { createFeaturedService } from '@/server/modules/featured';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
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
    const body = (await readJson(request)) as { expectedVersion?: unknown };
    if (typeof body.expectedVersion !== 'number') {
      throw err.input('缺少预期版本。', [{ path: 'expectedVersion', message: '必填' }]);
    }
    const service = createFeaturedService({ db: getDb() });
    return okJson(await service.publish(ctx, issueNumber, { expectedVersion: body.expectedVersion }), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
