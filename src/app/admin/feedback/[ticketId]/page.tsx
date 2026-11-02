/** 管理员：单条反馈处理页。 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import {
  createFeedbackService,
  FEEDBACK_ACTION_LABELS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
} from '@/server/modules/feedback';
import { DomainError, ErrorCodes } from '@/packages/common/errors';
import { formatDateTimeOr } from '@/packages/common/time';
import { FeedbackHandleForm } from '@/components/feedback-handle-form';

export const dynamic = 'force-dynamic';

export default async function AdminFeedbackDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const service = createFeedbackService({ db: getDb() });
  let ticket;
  try {
    ticket = await service.getForAdmin(ctx, ticketId);
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw e;
  }

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href="/admin/feedback">← 返回队列</Link>
      </p>

      <h1>{ticket.title}</h1>
      <div className="list-meta" style={{ marginBottom: 12 }}>
        <span className={ticket.status === 'open' ? 'tag warn' : 'tag site'}>
          {FEEDBACK_STATUS_LABELS[ticket.status]}
        </span>
        <span>{FEEDBACK_KIND_LABELS[ticket.kind]}</span>
        <span>提交人 {ticket.submittedBy?.nickname ?? ticket.submittedBy?.userId ?? '未知'}</span>
        <span>{formatDateTimeOr(ticket.createdAt, '未知')}</span>
      </div>

      <section className="panel">
        <div className="review-body" style={{ whiteSpace: 'pre-wrap' }}>{ticket.body}</div>
        {ticket.pageUrl ? (
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
            页面：{ticket.pageUrl}（{ticket.pageKind ?? '未识别'}）
          </p>
        ) : null}
        {ticket.contextJson ? (
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 12, wordBreak: 'break-all' }}>
            环境：{ticket.contextJson}
          </p>
        ) : null}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="section-head">
          <h2>处理</h2>
        </div>
        <FeedbackHandleForm ticketId={ticket.id} currentStatus={ticket.status} />
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
                  <span>{r.handledBy.nickname ?? r.handledBy.userId}</span>
                  <span>{formatDateTimeOr(r.createdAt, '未知')}</span>
                </div>
                <p style={{ margin: '6px 0 0' }}>理由：{r.reason}</p>
                {r.replyText ? <p className="muted" style={{ margin: '4px 0 0' }}>回复：{r.replyText}</p> : null}
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
