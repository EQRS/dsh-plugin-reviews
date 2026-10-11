/**
 * 插件详情（架构第 88 节）。
 * 未收录 / 不可访问返回 target_unavailable，不泄露私有内容。
 */

import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { err } from '@/packages/common/errors';
import { okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pluginId: string }> },
): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const { pluginId } = await params;
    const catalog = createCatalogService({ db: getDb() });
    const plugin = await catalog.getPlugin(pluginId);
    if (!plugin) throw err.unavailable('该插件不存在或不可访问。');
    return okJson(plugin, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
