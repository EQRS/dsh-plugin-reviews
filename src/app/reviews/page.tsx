/**
 * 全站评测列表（页面布局.md 第 4 节）：只列当前公开文章。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';

export const dynamic = 'force-dynamic';

interface Row {
  review_id: string;
  title: string;
  source_kind: 'community' | 'site';
  public_updated_at: number | null;
  author_nickname: string;
}

export default function ReviewsPage() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, r.source_kind, ce.public_updated_at, u.nickname AS author_nickname
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN users u ON u.id = ce.author_id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all() as Row[];
  const reviews = rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible);

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>评测</h1>
      <p style={{ color: '#526174' }}>共 {reviews.length} 篇公开评测</p>
      {reviews.length === 0 ? (
        <p style={{ color: '#526174' }}>暂无公开评测。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {reviews.map((r) => (
            <li
              key={r.review_id}
              style={{ background: '#FFFFFF', border: '1px solid #DBE1EA', borderRadius: 10, padding: 12, marginBottom: 8 }}
            >
              <Link href={`/reviews/${r.review_id}`} style={{ color: '#2456B8', fontWeight: 600 }}>
                {r.title}
              </Link>
              <div style={{ color: '#526174', fontSize: 14 }}>
                {r.source_kind === 'site' ? '站点评测' : '社区评测'} · {r.author_nickname} ·{' '}
                {r.public_updated_at === null ? '时间未知' : new Date(r.public_updated_at).toLocaleString('zh-CN')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
