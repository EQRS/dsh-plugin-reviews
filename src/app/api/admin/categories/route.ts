/**
 * 用途分类维护（`idea.md §12-§15` 的目录侧；迁移 0010）。
 *
 * GET    /api/admin/categories              所有分类（含隐藏）+ 原始 topics 的覆盖情况
 * POST   /api/admin/categories              新增或更新（slug 冲突即更新）
 * DELETE /api/admin/categories?slug=xxx     删除
 *
 * 为什么把"待归类 topics"一起返回：分类是**数据**，运营需要看见"哪些话题还没被认领"
 * 才知道该建什么分类 —— 不给这个视图，维护分类就只能靠猜。
 *
 * 权限每次从库里读角色（不缓存），非管理员 403。
 */

import { getDb } from '@/server/platform/db';
import { isAdmin } from '@/server/platform/context';
import { createCatalogService } from '@/server/modules/catalog';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const catalog = createCatalogService({ db: getDb() });
    const [categories, topics] = await Promise.all([catalog.listAllCategories(), catalog.listTopicUsage()]);
    return okJson({ categories, topics }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const body = (await readJson(request)) as {
      slug?: unknown;
      label?: unknown;
      topics?: unknown;
      sortOrder?: unknown;
      isVisible?: unknown;
    };
    if (typeof body.slug !== 'string' || typeof body.label !== 'string') {
      throw err.input('缺少分类标识或名称。', [
        { path: 'slug', message: '必填' },
        { path: 'label', message: '必填' },
      ]);
    }

    const catalog = createCatalogService({ db: getDb() });
    const saved = await catalog.upsertCategory(ctx, {
      slug: body.slug,
      label: body.label,
      topics: Array.isArray(body.topics) ? (body.topics as string[]) : [],
      sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
      isVisible: body.isVisible === undefined ? undefined : body.isVisible === true,
    });
    return okJson({ category: saved }, requestId, 201);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    if (!isAdmin(ctx)) throw err.forbidden('该操作需要管理员权限。');

    const slug = new URL(request.url).searchParams.get('slug');
    if (!slug) throw err.input('缺少 slug。', [{ path: 'slug', message: '必填' }]);

    const catalog = createCatalogService({ db: getDb() });
    const result = await catalog.deleteCategory(ctx, slug);
    if (!result.deleted) throw err.unavailable('该分类不存在（可能已被删除）。');
    return okJson(result, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
