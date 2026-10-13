/**
 * 首页（页面布局.md 第 3 节的三块：搜索入口、最新评测、近期更新插件）。
 *
 * 这里**不再**写"搜索、分类与筛选的完整交互见插件目录"这种空话 ——
 * 入口、评测、插件三块都真实渲染；没数据就显示空状态，不塞样例数据。
 *
 * 插件一块直接调 catalog 服务（而不是另写一段 SQL）：排序口径必须与 /plugins 一致，
 * 否则"首页说最近更新的是 A、目录说是 B"。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { createCatalogService } from '@/server/modules/catalog';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface Row {
  review_id: string;
  title: string;
  plugin_id: string | null;
  public_updated_at: number | null;
  source_kind: 'community' | 'site';
  plugin_display_name: string | null;
  plugin_path: string | null;
  repo_full_name: string | null;
}

function latestPublicReviews(limit: number): Row[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, r.plugin_id, ce.public_updated_at, r.source_kind,
              p.display_name AS plugin_display_name, p.plugin_path, repo.full_name AS repo_full_name
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
         LEFT JOIN plugins p ON p.id = r.plugin_id
         LEFT JOIN repositories repo ON repo.id = p.repository_id
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all() as Row[];
  // 公开资格逐行核验，不另存公开状态字段。
  return rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible).slice(0, limit);
}

/** 评测对应的插件展示名：清单名优先（缺则仓库全名），子目录形态带上子路径；插件被删也不会崩（LEFT JOIN）。 */
function pluginLabel(row: Row): string | null {
  if (row.repo_full_name === null) return null;
  const base = row.plugin_display_name ?? row.repo_full_name;
  const subPath = row.plugin_path && row.plugin_path !== '.' ? ` / ${row.plugin_path}` : '';
  return `${base}${subPath}`;
}

export default async function HomePage() {
  const reviews = latestPublicReviews(6);
  const catalog = createCatalogService({ db: getDb() });
  const recentPlugins = await catalog.listPlugins({ page: 1, page_size: 12 });

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>找 DSH 插件</h1>
      <p style={{ color: '#526174' }}>
        本站独立收录插件，<strong>收录 ≠ 已实测可用</strong>。评测由社区与站点分别撰写，公开前都经过人工审核。
      </p>

      {/* 搜索入口：GET 到目录页，条件留在 URL 里（目录页负责筛选与分页） */}
      <form action="/plugins" method="get" style={{ display: 'flex', gap: 8, marginTop: 12, maxWidth: 560 }}>
        <input
          type="search"
          name="q"
          placeholder="搜插件名、作者仓库或简介"
          aria-label="搜索插件"
          style={{ flex: '1 1 auto', padding: '8px 10px', border: '1px solid #DBE1EA', borderRadius: 8 }}
        />
        <button type="submit" style={{ background: '#2456B8', color: '#FFFFFF', border: 'none', borderRadius: 8, padding: '8px 16px' }}>
          搜索
        </button>
        <Link
          href="/plugins"
          style={{ alignSelf: 'center', color: '#2456B8', textDecoration: 'none', whiteSpace: 'nowrap' }}
        >
          浏览全部 / 按用途筛选
        </Link>
      </form>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>最新评测</h2>
        {reviews.length === 0 ? (
          <p style={{ color: '#526174' }}>
            暂无公开评测。可以先去 <Link href="/plugins">插件目录</Link> 收录一个插件再写。
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {reviews.map((r) => (
              <li
                key={r.review_id}
                style={{
                  background: '#FFFFFF',
                  border: '1px solid #DBE1EA',
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 8,
                }}
              >
                <Link href={`/reviews/${r.review_id}`} style={{ color: '#2456B8', fontWeight: 600 }}>
                  {r.title}
                </Link>
                <div style={{ color: '#526174', fontSize: 14 }}>
                  <span
                    style={{
                      background: r.source_kind === 'site' ? '#EEF3FF' : '#F3F5F8',
                      borderRadius: 4,
                      padding: '1px 6px',
                      marginRight: 8,
                    }}
                  >
                    {r.source_kind === 'site' ? '站点评测' : '社区评测'}
                  </span>
                  {pluginLabel(r) === null ? (
                    '插件信息不可用'
                  ) : (
                    <Link href={`/plugins/${r.plugin_id}`} style={{ color: '#526174' }}>
                      {pluginLabel(r)}
                    </Link>
                  )}
                  {' · '}
                  {formatDateTimeOr(r.public_updated_at, '时间未知')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>近期更新插件</h2>
        {recentPlugins.items.length === 0 ? (
          <p style={{ color: '#526174' }}>
            还没有收录任何插件。可以从 <Link href="/plugins/new">提交插件</Link> 开始。
          </p>
        ) : (
          <>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {recentPlugins.items.map((p) => (
                <li key={p.pluginId} style={{ padding: '6px 0' }}>
                  <Link href={`/plugins/${p.pluginId}`} style={{ color: '#2456B8', fontWeight: 600 }}>
                    {p.displayName ?? p.repositoryFullName}
                  </Link>
                  <span style={{ color: '#526174', fontSize: 14 }}>
                    {' · '}
                    {p.description ?? '暂无简介'}
                    {' · '}
                    {p.publicReviewCount > 0 ? `${p.publicReviewCount} 篇公开评测` : '暂无评测'}
                    {' · '}
                    资料更新 {formatDateTimeOr(p.infoUpdatedAt ?? p.updatedAt, '未知')}
                  </span>
                </li>
              ))}
            </ul>
            {recentPlugins.total > recentPlugins.items.length ? (
              <p style={{ color: '#526174', fontSize: 14 }}>
                目录里共有 {recentPlugins.total} 个条目，<Link href="/plugins">查看全部</Link>。
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
