/**
 * 恢复某个字段的同步资料（删掉管理员的覆盖值）。
 *
 * DELETE /api/admin/plugins/{pluginId}/overrides/{fieldKey}
 *
 * 不需要重新探测 GitHub：`plugins` 里本来就是同步来的原值，删掉 override 就回到它。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createCorrectionsService, type CorrectionField } from '@/server/modules/corrections';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../../../_lib/context';

export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ pluginId: string; fieldKey: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const { pluginId, fieldKey } = await params;
    const service = createCorrectionsService({ db: getDb() });
    const result = await service.revertOverride(ctx, pluginId, fieldKey as CorrectionField);
    if (!result.reverted) throw err.unavailable('该字段当前没有管理员修正。');
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
