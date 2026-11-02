/** 我的单条反馈详情（越权由服务层 404）。 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAuthenticated } from '@/server/platform/context';
import { booleanSetting } from '@/server/modules/settings';
import {
  createFeedbackService,
  FEEDBACK_ACTION_LABELS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
} from '@/server/modules/feedback';
import { DomainError, ErrorCodes } from '@/packages/common/errors';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function FeedbackDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const db = getDb();
  if (!booleanSetting(db, 'feedback.enabled', true)) notFound();

  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/feedback');

  const service = createFeedbackService({ db });
  let ticket;
  try {
    ticket = await service.getMine(ctx, ticketId);
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw e;
  }

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href="/feedback">← 返回反馈列表</Link>
      </p>

      <h1>{ticket.title}</h1>
      <div className="list-meta" style={{ marginBottom: 12 }}>
        <span className={ticket.status === 'open' ? 'tag warn' : 'tag site'}>
          {FEEDBACK_STATUS_LABELS[ticket.status]}
        </span>
        <span>{FEEDBACK_KIND_LABELS[ticket.kind]}</span>
        <span>提交于 {formatDateTimeOr(ticket.createdAt, '未知')}</span>
        {ticket.pageUrl ? <span>页面 {ticket.pageUrl}</span> : null}
      </div>

      <section className="panel">
        <div className="review-body" style={{ whiteSpace: 'pre-wrap' }}>{ticket.body}</div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="section-head">
          <h2>处理记录（{ticket.records?.length ?? 0}）</h2>
        </div>
        {ticket.records && ticket.records.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {ticket.records.map((r) => (
              <li key={r.id} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
                <div className="list-meta">
                  <span className="tag">{FEEDBACK_ACTION_LABELS[r.action]}</span>
                  <span>{formatDateTimeOr(r.createdAt, '未知')}</span>
                </div>
                {r.replyText ? <p style={{ margin: '6px 0 0' }}>{r.replyText}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty" style={{ marginBottom: 0 }}>还没有处理记录。</p>
        )}
      </section>
    </div>
  );
}
