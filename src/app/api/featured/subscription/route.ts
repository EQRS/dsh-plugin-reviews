/**
 * 精选订阅（订阅栏目，不是单期）。
 *
 * GET    /api/featured/subscription   我的订阅状态
 * POST   /api/featured/subscription   订阅（幂等）
 * DELETE /api/featured/subscription   取消订阅
 */

import { getDb } from '@/server/platform/db';
import { createFeaturedSubscriptionService } from '@/server/modules/featured';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const service = createFeaturedSubscriptionService({ db: getDb() });
    return okJson(await service.getState(ctx), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const service = createFeaturedSubscriptionService({ db: getDb() });
    return okJson(await service.subscribe(ctx), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const service = createFeaturedSubscriptionService({ db: getDb() });
    return okJson(await service.unsubscribe(ctx), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
