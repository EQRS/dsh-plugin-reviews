/** 管理员：单条反馈详情（含处理历史）GET /api/admin/feedback/{id} */

import { getDb } from '@/server/platform/db';
import { assertCanAdmin } from '@/server/platform/context';
import { createFeedbackService } from '@/server/modules/feedback';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { ticketId } = await params;
    const ctx = await currentContext();
    assertCanAdmin(ctx);
    const service = createFeedbackService({ db: getDb() });
    return okJson(await service.getForAdmin(ctx, ticketId), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
