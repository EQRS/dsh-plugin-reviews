/**
 * 处理一条资料纠错（`idea.md §2`/§23）：采纳（写覆盖字段）或驳回。
 *
 * POST /api/admin/corrections/{correctionId}/handle   { action: 'accept' | 'reject', reason }
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createCorrectionsService } from '@/server/modules/corrections';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ correctionId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const { correctionId } = await params;
    const body = (await readJson(request)) as { action?: unknown; reason?: unknown };
    if (body.action !== 'accept' && body.action !== 'reject') {
      throw err.input('处理动作不合法。', [{ path: 'action', message: 'accept / reject' }]);
    }
    if (typeof body.reason !== 'string') {
      throw err.input('缺少处理原因。', [{ path: 'reason', message: '必填' }]);
    }

    const service = createCorrectionsService({ db: getDb() });
    const result = await service.handleCorrection(ctx, correctionId, {
      action: body.action,
      reason: body.reason,
    });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
