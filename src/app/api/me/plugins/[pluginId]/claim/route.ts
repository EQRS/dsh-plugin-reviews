/**
 * 认领插件。
 *
 * POST /api/me/plugins/{pluginId}/claim → { note? }
 *   能对上 GitHub 账号时直接 verified；否则落 pending 等管理员审核。
 */
import { getDb } from '@/server/platform/db';
import { createPluginOwnershipService } from '@/server/modules/roles/ownership';
import { assertCanWrite } from '@/server/platform/context';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ pluginId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    // 先认人再读 body（全站约定）：匿名配一个坏 body 应是 401 而不是 400。
    // 服务层 claimPlugin 里也会 assertCanWrite，但那发生在读完 body 之后，太晚了。
    assertCanWrite(ctx);
    const { pluginId } = await context.params;
    const body = (await readJson(request)) as { note?: unknown };
    const note = typeof body.note === 'string' ? body.note : '';
    const service = createPluginOwnershipService({ db: getDb() });
    const result = await service.claimPlugin(ctx, pluginId, { note });
    return okJson(result, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
