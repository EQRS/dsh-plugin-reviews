/**
 * 后台资料纠错队列（`idea.md §23`）。
 *
 * GET /api/admin/corrections?state=open|accepted|rejected|all
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createCorrectionsService, type CorrectionState } from '@/server/modules/corrections';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

const STATES = ['open', 'accepted', 'rejected', 'all'];

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const raw = new URL(request.url).searchParams.get('state') ?? 'open';
    if (!STATES.includes(raw)) {
      throw err.input('未知的纠错状态。', [{ path: 'state', message: `可选：${STATES.join(' / ')}` }]);
    }

    const service = createCorrectionsService({ db: getDb() });
    const corrections = await service.listCorrections(ctx, { state: raw as CorrectionState | 'all' });
    return okJson({ corrections }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
