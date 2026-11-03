/**
 * 插件搜索（精简版）：给精选编辑页的「搜索插件目录添加」用。
 *
 * GET /api/plugins/search?q=关键词&limit=10
 *
 * 只返回选品需要的字段（id / 展示名 / 仓库 / 子路径），不返回简介与统计：
 * 编辑要的是「把这个插件加进来」，不是浏览目录。
 */

import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { okJson, errorResponse, requestMeta } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    const limit = Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '10', 10) || 10));

    const catalog = createCatalogService({ db: getDb() });
    const result = await catalog.listPlugins({ page: 1, page_size: limit, q: q || undefined });
    return okJson(
      {
        items: result.items.map((plugin) => ({
          pluginId: plugin.pluginId,
          displayName: plugin.displayName,
          pluginPath: plugin.pluginPath,
          repositoryFullName: plugin.repositoryFullName,
          ownerAvatarUrl: plugin.ownerAvatarUrl ?? null,
        })),
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
