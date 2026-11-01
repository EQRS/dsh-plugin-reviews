/**
 * 管理端精选专栏。
 *
 * GET  /api/admin/featured   全部期（含草稿）
 * POST /api/admin/featured   新建草稿（期号自动分配）
 */

import { getDb } from '@/server/platform/db';
import { createFeaturedService } from '@/server/modules/featured';
import { err } from '@/packages/common/errors';
import { assertCanAdmin } from '@/server/platform/context';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 鉴权先于读 body：匿名/越权请求不该先拿到「参数错误」(400)
    assertCanAdmin(ctx);
    const service = createFeaturedService({ db: getDb() });
    return okJson({ items: await service.listForAdmin(ctx) }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 鉴权先于读 body：匿名/越权请求不该先拿到「参数错误」(400)
    assertCanAdmin(ctx);
    const body = (await readJson(request)) as {
      title?: unknown;
      theme?: unknown;
      prefaceMd?: unknown;
      requestKey?: unknown;
    };
    if (typeof body.title !== 'string' || typeof body.theme !== 'string') {
      throw err.input('标题与主题必填。', [{ path: 'title', message: '必填' }]);
    }
    if (typeof body.requestKey !== 'string' || body.requestKey.trim() === '') {
      throw err.input('缺少请求标识。', [{ path: 'requestKey', message: '必填' }]);
    }
    const service = createFeaturedService({ db: getDb() });
    const result = await service.createDraft(ctx, {
      title: body.title,
      theme: body.theme,
      prefaceMd: typeof body.prefaceMd === 'string' ? body.prefaceMd : '',
      requestKey: body.requestKey,
    });
    return okJson(result, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
