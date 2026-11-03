/** 管理员：反馈队列 GET /api/admin/feedback?status=open&kind=bug&page=1 */

import { getDb } from '@/server/platform/db';
import { assertCanAdmin } from '@/server/platform/context';
import { createFeedbackService, FEEDBACK_KINDS, FEEDBACK_STATUSES } from '@/server/modules/feedback';
import type { FeedbackKind, FeedbackStatus } from '@/server/modules/feedback';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanAdmin(ctx);
    const url = new URL(request.url);
    const statusRaw = url.searchParams.get('status') ?? 'open';
    const kindRaw = url.searchParams.get('kind') ?? 'all';
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);

    const status =
      statusRaw !== 'all' && FEEDBACK_STATUSES.includes(statusRaw as FeedbackStatus)
        ? (statusRaw as FeedbackStatus)
        : statusRaw === 'all'
          ? ('all' as const)
          : ('open' as const);
    const kind =
      kindRaw !== 'all' && FEEDBACK_KINDS.includes(kindRaw as FeedbackKind)
        ? (kindRaw as FeedbackKind)
        : ('all' as const);

    const service = createFeedbackService({ db: getDb() });
    return okJson(await service.listQueue(ctx, { status, kind, page: Number.isFinite(page) ? page : 1 }), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
