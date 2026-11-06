/**
 * 我的插件。
 *
 * GET /api/me/plugins → 当前用户归属的插件（含待审与被驳回的）
 */
import { getDb } from '@/server/platform/db';
import { createPluginOwnershipService } from '@/server/modules/roles/ownership';
import { currentContext, okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (ctx.userId === null) {
      return okJson({ plugins: [], authenticated: false }, requestId);
    }
    const service = createPluginOwnershipService({ db: getDb() });
    const plugins = await service.listMine(ctx);
    return okJson({ plugins, authenticated: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
