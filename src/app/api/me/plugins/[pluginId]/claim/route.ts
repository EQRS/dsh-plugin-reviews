/**
 * 认领插件。
 *
 * POST /api/me/plugins/{pluginId}/claim → { note? }
 *   能对上 GitHub 账号时直接 verified；否则落 pending 等管理员审核。
 */
import { getDb } from '@/server/platform/db';
import { createPluginOwnershipService } from '@/server/modules/roles/ownership';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../../_lib/context';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ pluginId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
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
