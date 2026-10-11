/**
 * 插件详情（页面布局.md 第 5 节）：插件介绍与本站评测同页可达。
 *
 * 最小切片只展示已同步的结构化资料与本站评测入口；
 * README 抓取、安装资料核验属本切片范围外。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { resolveVisibilityInTx } from '@/server/modules/content';

export const dynamic = 'force-dynamic';

export default async function PluginDetailPage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  const db = getDb();
  const catalog = createCatalogService({ db });
  const plugin = await catalog.getPlugin(pluginId);
  if (!plugin) notFound();

  // 本插件下的公开评测
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, ce.public_updated_at
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        WHERE r.plugin_id = ?
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all(pluginId) as { review_id: string; title: string; public_updated_at: number | null }[];
  const reviews = rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible);

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>
        {plugin.repository.fullName}
        {plugin.pluginPath === '.' ? '' : ` / ${plugin.pluginPath}`}
      </h1>
      <p style={{ color: '#526174' }}>
        仓库：{' '}
        <a href={plugin.repository.htmlUrl} style={{ color: '#2456B8' }}>
          {plugin.repository.htmlUrl}
        </a>
        <br />
        上游状态：{plugin.repository.availabilityState}
        {plugin.repository.isArchived ? ' · 已归档' : ''}
        <br />
        子路径：<code>{plugin.pluginPath}</code>
      </p>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 20 }}>本站评测</h2>
        {reviews.length === 0 ? (
          <p style={{ color: '#526174' }}>暂无评测。</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {reviews.map((r) => (
              <li key={r.review_id} style={{ marginBottom: 6 }}>
                <Link href={`/reviews/${r.review_id}`} style={{ color: '#2456B8' }}>
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={{ marginTop: 24 }}>
        <Link href="/plugins" style={{ color: '#526174' }}>
          ← 返回插件目录
        </Link>
      </p>
    </div>
  );
}
