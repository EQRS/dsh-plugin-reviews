/**
 * 管理员：处理一条反馈。
 *
 * POST /api/admin/feedback/{id}/handle  { action, reason, replyText?, duplicateOf? }
 *
 * action: acknowledge / fix / duplicate / wontfix / unreproducible / reopen
 * 必须写 reason（处理留痕）；replyText 是给提交人的回复（缺省时通知正文用 reason）。
 */

import { getDb } from '@/server/platform/db';
import { assertCanAdmin } from '@/server/platform/context';
import { createFeedbackService } from '@/server/modules/feedback';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ticketId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { ticketId } = await params;
    const ctx = await currentContext();
    // 鉴权先于读 body
    assertCanAdmin(ctx);

    const body = (await readJson(request)) as {
      action?: unknown;
      reason?: unknown;
      replyText?: unknown;
      duplicateOf?: unknown;
    };
    if (typeof body.action !== 'string') {
      throw err.input('缺少处理动作。', [{ path: 'action', message: '必填' }]);
    }

    const service = createFeedbackService({ db: getDb() });
    return okJson(
      await service.handle(ctx, ticketId, {
        action: body.action,
        reason: body.reason,
        replyText: body.replyText,
        duplicateOf: body.duplicateOf,
      }),
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
