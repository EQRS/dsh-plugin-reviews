/**
 * 全站评测列表（页面布局.md 第 4 节）：只列当前公开文章。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { formatDateTime } from '@/packages/common/time';

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
      <h1>评测</h1>
      <p className="muted">共 {reviews.length} 篇公开评测</p>
      <div className="panel">
        {reviews.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            暂无公开评测。
          </p>
        ) : (
          <ul className="item-list">
            {reviews.map((r) => (
              <li key={r.review_id} className="item">
                <div className="item-body">
                  <h3>
                    <Link href={`/reviews/${r.review_id}`}>
                      {r.title}
                    </Link>
                  </h3>
                  <div className="list-meta">
                    {r.source_kind === 'site' ? '站点评测' : '社区评测'} · {r.author_nickname} ·{' '}
                    {r.public_updated_at === null ? '时间未知' : formatDateTime(r.public_updated_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}