/**
 * "有帮助"（`idea.md §13`）：GET 查状态与总数，POST 切换（登录、一人一票、可取消）。
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createInteractionsService } from '@/server/modules/interactions';
import { currentContext, okJson, errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { reviewId } = await params;
    const ctx = await currentContext();
    const service = createInteractionsService({ db: getDb() });
    const state = await service.helpfulState(reviewId, ctx.userId);
    return okJson(state, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { reviewId } = await params;
    const ctx = await currentContext();
    assertCanWrite(ctx);
    // 频控刻意不挂：一人一票 + 可取消，天然没有放大面
    const service = createInteractionsService({ db: getDb() });
    const state = await service.toggleHelpful(ctx, reviewId);
    return okJson(state, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
