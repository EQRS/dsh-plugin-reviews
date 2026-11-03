/** 精选专栏列表（公开，仅已发布）。GET /api/featured?page=1 */

import { getDb } from '@/server/platform/db';
import { createFeaturedService } from '@/server/modules/featured';
import { okJson, errorResponse, requestMeta } from '../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const page = Number.parseInt(new URL(request.url).searchParams.get('page') ?? '1', 10);
    const service = createFeaturedService({ db: getDb() });
    const result = await service.listPublished({ page: Number.isFinite(page) ? page : 1 });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
