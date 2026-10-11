/**
 * 首页（页面布局.md 第 3 节的三块内容：搜索/分类入口、最新评测、近期更新插件）。
 *
 * 本切片只真实渲染"最新公开评测"一块（其余入口给链接），
 * 不塞样例数据 —— 没数据就显示空状态。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';

export const dynamic = 'force-dynamic';

interface Row {
  review_id: string;
  title: string;
  plugin_id: string | null;
  public_updated_at: number | null;
  source_kind: 'community' | 'site';
}

function latestPublicReviews(limit: number): Row[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, r.plugin_id, ce.public_updated_at, r.source_kind
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all() as Row[];
  // 公开资格逐行核验，不另存公开状态字段。
  return rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible).slice(0, limit);
}

export default function HomePage() {
  const reviews = latestPublicReviews(6);

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>找 DSH 插件</h1>
      <p style={{ color: '#526174' }}>
        搜索、分类与筛选的完整交互见 <Link href="/plugins">插件目录</Link>；
        本站独立收录插件，收录 ≠ 已实测可用。
      </p>

      <section style={{ marginTop: 24 }}>
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
                  {r.public_updated_at === null ? '时间未知' : new Date(r.public_updated_at).toLocaleString('zh-CN')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
