/**
 * 全站公开评测列表（架构第 88.1、88.3 节）。
 *
 * 只返回**当前公开**的文章：存在有效公开修订 且 未撤回 且 未隐藏。
 * 关键词搜索与筛选属本切片范围外（见「未按文档实现」清单）；
 * 这里只做分页 + 公开资格过滤，且资格在每行上真实核验。
 */

import { getDb } from '@/server/platform/db';
import { err } from '@/packages/common/errors';
import { PaginationDefaults, buildPage } from '@/packages/common/result';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { okJson, errorResponse, requestMeta } from '../_lib/context';

export const runtime = 'nodejs';

interface Row {
  review_id: string;
  plugin_id: string | null;
  source_kind: 'community' | 'site';
  title: string;
  revision_id: string;
  revision_number: number;
  published_at: number;
}

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('page_size') ?? String(PaginationDefaults.default_page_size));

    if (!Number.isInteger(page) || page < 1) {
      throw err.input('页码必须是从 1 开始的正整数。', [{ path: 'page', message: '取值不合法' }]);
    }
    if (!(PaginationDefaults.allowed_page_sizes as readonly number[]).includes(pageSize)) {
      throw err.input(
        `每页条数只允许 ${PaginationDefaults.allowed_page_sizes.join('、')}。`,
        [{ path: 'page_size', message: '取值不合法' }],
      );
    }

    const db = getDb();

    // 候选行：所有已切换公开修订的文章，按发布时间从新到旧 + 固定 ID 保证同值稳定次序。
    const candidates = db
      .prepare(
        `SELECT r.id AS review_id, r.plugin_id, r.source_kind,
                rev.title, rev.id AS revision_id, rev.revision_number,
                ce.public_updated_at AS published_at
           FROM reviews r
           JOIN content_entities ce ON ce.id = r.id
           JOIN review_revisions rev ON rev.id = r.published_revision_id
          ORDER BY ce.public_updated_at DESC, r.id ASC`,
      )
      .all() as Row[];

    // 公开资格逐行核验（不另存"公开状态"字段，统一走可见性解析）。
    const visible = candidates.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible);

    const total = visible.length;
    const offset = (page - 1) * pageSize;
    const pageRows = visible.slice(offset, offset + pageSize);

    const items = pageRows.map((row) => ({
      reviewId: row.review_id,
      pluginId: row.plugin_id,
      sourceKind: row.source_kind,
      title: row.title,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      publishedAt: row.published_at === null ? null : new Date(row.published_at).toISOString(),
    }));

    return okJson(buildPage(items, total, { page, page_size: pageSize }), requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
