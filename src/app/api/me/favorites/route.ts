/**
 * 收藏（`idea.md §15`）：GET 我的收藏，POST 切换，DELETE 取消（登录）。
 *
 * 三类内容（插件 / 整合包 / 帖子）共用一套收藏夹（迁移 0039）。
 *
 * **兼容口径（别改）**：不传 kind 一律按 `plugin` 走。0039 之前这个接口只有插件语义，
 * 老前端（收藏按钮、老收藏页）不带 kind，必须照旧。
 *
 *  - GET     ?kind=         → { kind, folders, plugins, items, authenticated }
 *                             `plugins` 字段保持原样（老页面靠它），另给一份泛化的 `items`。
 *  - POST    body { kind?, targetId, folderId? } → { favorited, folderId? }
 *                             有 folderId 走 setFavoriteInKind（移动/收进指定夹），没 folderId 走 toggleFavorite。
 *  - DELETE  ?targetId=&kind= 或老写法 ?pluginId= → { favorited: false }
 */

import { getDb } from '@/server/platform/db';
import { assertCanWrite } from '@/server/platform/context';
import { createInteractionsService, type FavoriteTargetKind } from '@/server/modules/interactions';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';
import { parseKind } from '../../_lib/kind';

export const runtime = 'nodejs';

const KIND_HINT = { path: 'kind', message: '必须是 plugin / pack / post' };

/** 把 kind 解析失败统一成 input_invalid。 */
function requireKind(raw: unknown): FavoriteTargetKind {
  const kind = parseKind(raw);
  if (kind === null) throw err.input('收藏类型不合法。', [KIND_HINT]);
  return kind;
}

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    const kind = requireKind(new URL(request.url).searchParams.get('kind'));
    const service = createInteractionsService({ db: getDb() });
    const folders = ctx.userId === null ? [] : await service.listFavoriteFolders(ctx, kind);
    // 老字段：插件清单保持原样，老页面 / 老收藏按钮只认它
    const plugins = ctx.userId === null ? [] : await service.listFavoritePlugins(ctx);
    const items =
      ctx.userId === null || kind === 'plugin'
        ? []
        : kind === 'pack'
          ? await service.listFavoritePacks(ctx)
          : await service.listFavoritePosts(ctx);
    return okJson({ kind, folders, plugins, items, authenticated: ctx.userId !== null }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 取消收藏：DELETE /api/me/favorites?targetId=...&kind=...（老写法 ?pluginId= 仍按插件处理）。 */
export async function DELETE(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const params = new URL(request.url).searchParams;
    // 老写法只给 pluginId，没有 kind 时也必须按插件走，不能因为多了新参数把老调用打断
    const legacyPluginId = params.get('pluginId');
    const targetId = params.get('targetId') ?? legacyPluginId;
    const kind = requireKind(params.get('kind') ?? (legacyPluginId !== null ? 'plugin' : undefined));
    if (!targetId) {
      throw err.input('缺少收藏目标。', [
        { path: 'targetId', message: '必填' },
        { path: 'pluginId', message: '旧写法，兼容插件' },
      ]);
    }
    const service = createInteractionsService({ db: getDb() });
    if (kind === 'plugin') {
      const result = await service.removeFavorite(ctx, targetId);
      return okJson(result, requestId);
    }
    // 取消收藏**不校验目标是否还可公开**：
    // 目标被撤回/下架后，那行收藏不该变成删不掉的死结。
    // 归属由 user_id 保证，目标状态与此无关。
    const result = await service.removeFavoriteInKind(ctx, { kind, targetId });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    assertCanWrite(ctx);
    const body = (await readJson(request)) as {
      kind?: unknown;
      targetId?: unknown;
      folderId?: unknown;
      pluginId?: unknown;
    };
    // 老写法是 { pluginId }，新写法是 { kind, targetId }：两个都收，且老写法不带 kind 时按插件走
    const legacyPluginId = typeof body.pluginId === 'string' && body.pluginId.length > 0 ? body.pluginId : null;
    const targetId = typeof body.targetId === 'string' && body.targetId.length > 0 ? body.targetId : legacyPluginId;
    if (targetId === null) {
      throw err.input('缺少收藏目标。', [
        { path: 'targetId', message: '必填' },
        { path: 'pluginId', message: '旧写法，兼容插件' },
        KIND_HINT,
      ]);
    }
    const kind = requireKind(body.kind ?? (legacyPluginId !== null ? 'plugin' : undefined));
    const service = createInteractionsService({ db: getDb() });
    if (typeof body.folderId === 'string' && body.folderId.length > 0) {
      // 三类通用：夹必须属于本人且类型匹配（assertFolderOwned 在服务层判）
      const result = await service.setFavoriteInKind(ctx, {
        kind,
        targetId,
        folderId: body.folderId,
      });
      return okJson(result, requestId);
    }
    // 没给夹：一律**幂等收藏到默认夹**，三类同一语义。
    //
    // 审查指出过原先的不一致：插件走 setFavorite（幂等）、帖子走 toggle（再点取消），
    // 同一个按钮两种行为。现在 POST 只负责「收藏」，取消一律走 DELETE。
    const result = await service.favoriteToDefaultFolder(ctx, { kind, targetId });
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
