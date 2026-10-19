/**
 * 处理一条举报（`idea.md §20/§23`）：隐藏 / 驳回 / 要求补充证据。
 *
 * POST /api/admin/reports/{reportId}/handle   { action, reason }
 *
 * 处理结果会写进 `report_handling_records`，并以 `moderation_result` 通知发给举报人
 * （隐藏时还给内容作者发一条）。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createInteractionsService, type ReportAction } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

const ACTIONS: ReportAction[] = ['hide', 'dismiss', 'request_evidence'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const { reportId } = await params;
    const body = (await readJson(request)) as { action?: unknown; reason?: unknown };
    if (typeof body.action !== 'string' || !ACTIONS.includes(body.action as ReportAction)) {
      throw err.input('处理动作不合法。', [{ path: 'action', message: `可选：${ACTIONS.join(' / ')}` }]);
    }
    if (typeof body.reason !== 'string') {
      throw err.input('缺少处理原因。', [{ path: 'reason', message: '必填' }]);
    }

    const service = createInteractionsService({ db: getDb() });
    const result = await service.handleReport(ctx, reportId, {
      action: body.action as ReportAction,
      reason: body.reason,
    });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
