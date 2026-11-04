/**
 * 收藏夹列表 / 新建。
 *
 * GET  /api/me/favorites/folders?kind=  → 当前用户某一类的收藏夹（含计数；首次访问懒建默认夹）
 * POST /api/me/favorites/folders        → { name, kind? } 新建收藏夹（同一类型内重名拒绝）
 *
 * kind 缺省一律 `plugin`（0039 之前只有插件夹，老调用不带这个参数）。
 * 名字只在同类型内查重：插件夹「常用」与帖子夹「常用」是两个夹，可以同名。
 */
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../../_lib/context';
import { parseKind } from '../../../_lib/kind';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const kind = parseKind(new URL(request.url).searchParams.get('kind'));
    if (kind === null) throw err.input('收藏类型不合法。', [{ path: 'kind', message: '必须是 plugin / pack / post' }]);
    const service = createInteractionsService({ db: getDb() });
    const folders = ctx.userId === null ? [] : await service.listFavoriteFolders(ctx, kind);
    return okJson({ kind, folders, authenticated: ctx.userId !== null }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const body = (await readJson(request)) as { name?: unknown; kind?: unknown };
    if (typeof body.name !== 'string') {
      throw err.input('缺少收藏夹名称。', [{ path: 'name', message: '必填' }]);
    }
    const kind = parseKind(body.kind);
    if (kind === null) throw err.input('收藏类型不合法。', [{ path: 'kind', message: '必须是 plugin / pack / post' }]);
    const service = createInteractionsService({ db: getDb() });
    const folder = await service.createFavoriteFolder(ctx, body.name, kind);
    return okJson(folder, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
