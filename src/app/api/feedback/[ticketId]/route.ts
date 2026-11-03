/** 我的单条反馈：GET /api/feedback/{id}（越权一律 404）。 */

import { getDb } from '@/server/platform/db';
import { createFeedbackService } from '@/server/modules/feedback';
import { booleanSetting } from '@/server/modules/settings';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { ticketId } = await params;
    const ctx = await currentContext();
    if (ctx.userId === null) throw err.unauthenticated();
    const db = getDb();
    if (!booleanSetting(db, 'feedback.enabled', true)) throw err.unavailable('问题反馈暂未开放。');
    const service = createFeedbackService({ db });
    return okJson(await service.getMine(ctx, ticketId), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
