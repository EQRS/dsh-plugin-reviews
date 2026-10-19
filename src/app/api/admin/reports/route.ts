/**
 * 后台举报队列（`idea.md §23`）。
 *
 * GET /api/admin/reports?state=open|resolved|dismissed|all
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createInteractionsService, type ReportState } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

const STATES = ['open', 'resolved', 'dismissed', 'all'];

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const raw = new URL(request.url).searchParams.get('state') ?? 'open';
    if (!STATES.includes(raw)) {
      throw err.input('未知的举报状态。', [{ path: 'state', message: `可选：${STATES.join(' / ')}` }]);
    }

    const service = createInteractionsService({ db: getDb() });
    const reports = await service.listReports(ctx, { state: raw as ReportState | 'all' });
    return okJson({ reports }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
