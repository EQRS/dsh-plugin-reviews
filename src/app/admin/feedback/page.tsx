/** 管理员：反馈队列（默认只看待处理）。 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import {
  createFeedbackService,
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
} from '@/server/modules/feedback';
import type { FeedbackKind, FeedbackStatus } from '@/server/modules/feedback';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const sp = await searchParams;
  const statusRaw = firstValue(sp.status) ?? 'open';
  const kindRaw = firstValue(sp.kind) ?? 'all';
  const status =
    statusRaw === 'all'
      ? ('all' as const)
      : FEEDBACK_STATUSES.includes(statusRaw as FeedbackStatus)
        ? (statusRaw as FeedbackStatus)
        : ('open' as const);
  const kind =
    kindRaw !== 'all' && FEEDBACK_KINDS.includes(kindRaw as FeedbackKind)
      ? (kindRaw as FeedbackKind)
      : ('all' as const);

  const service = createFeedbackService({ db: getDb() });
  const result = await service.listQueue(ctx, { status, kind });

  const linkFor = (nextStatus: string, nextKind: string) =>
    '/admin/feedback?status=' + nextStatus + '&kind=' + nextKind;

  return (
    <div>
      <div className="section-head">
        <h1 style={{ margin: 0 }}>问题反馈</h1>
        <Link href="/admin">← 返回管理后台</Link>
      </div>

      <div className="filters" style={{ marginTop: 8 }}>
        <Link href={linkFor('open', kind)} className={status === 'open' ? 'active' : ''}>待处理</Link>
        <Link href={linkFor('acknowledged', kind)} className={status === 'acknowledged' ? 'active' : ''}>已确认</Link>
        <Link href={linkFor('all', kind)} className={status === 'all' ? 'active' : ''}>全部</Link>
      </div>
      <div className="filters" style={{ marginTop: 6 }}>
        <Link href={linkFor(status, 'all')} className={kind === 'all' ? 'active' : ''}>全部类型</Link>
        {FEEDBACK_KINDS.map((k) => (
          <Link key={k} href={linkFor(status, k)} className={kind === k ? 'active' : ''}>
            {FEEDBACK_KIND_LABELS[k]}
          </Link>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 12 }}>
        <div className="section-head">
          <h2>共 {result.total} 条</h2>
        </div>
        {result.items.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>这个筛选下没有反馈。</p>
        ) : (
          <ul className="item-list">
            {result.items.map((t) => (
              <li key={t.id} className="item">
                <div className="item-body">
                  <div className="item-head">
                    <span className={t.status === 'open' ? 'tag warn' : 'tag site'}>
                      {FEEDBACK_STATUS_LABELS[t.status]}
                    </span>
                    <div className="item-main">
                      <h3 className="item-title">
                        <Link href={'/admin/feedback/' + t.id}>{t.title}</Link>
                      </h3>
                      <div className="list-meta">
                        <span>{FEEDBACK_KIND_LABELS[t.kind]}</span>
                        <span>{t.submittedBy?.nickname ?? '未知用户'}</span>
                        <span>{formatDateTimeOr(t.createdAt, '未知')}</span>
                        {t.pageUrl ? <span>{t.pageUrl}</span> : null}
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
