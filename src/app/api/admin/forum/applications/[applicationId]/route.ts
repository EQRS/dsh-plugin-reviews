/**
 * 后台：审批分区申请
 *   POST { action: 'approve' | 'reject', note?: string }
 */

import { getDb } from '@/server/platform/db';
import { assertCanAdmin } from '@/server/platform/context';
import { createForumBoardApplicationService } from '@/server/modules/forum/applications';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson, assertForumEnabled } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ applicationId: string }> }) {
  const { requestId } = requestMeta(request);
  try {
    assertForumEnabled();
    const { applicationId } = await params;
    const ctx = await currentContext();
    assertCanAdmin(ctx);

    const body = (await readJson(request)) as { action?: unknown; note?: unknown };
    const action = body.action;
    if (action !== 'approve' && action !== 'reject') {
      throw err.input('action 必须是 approve 或 reject。', [{ path: 'action', message: '未知动作' }]);
    }

    const service = createForumBoardApplicationService({ db: getDb() });
    if (action === 'approve') {
      const result = await service.approve(ctx, applicationId, body.note);
      return okJson(result, requestId);
    }
    await service.reject(ctx, applicationId, body.note);
    return okJson({ rejected: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
