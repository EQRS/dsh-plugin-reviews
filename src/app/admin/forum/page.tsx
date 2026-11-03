/**
 * 后台 · 讨论区：分区申请审核队列。
 *
 * 默认只看待处理，可按状态切换。通过时申请人自动成为区长（服务层保证）。
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { isAdmin, isAuthenticated } from '@/server/platform/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumBoardApplicationService } from '@/server/modules/forum/applications';
import {
  BOARD_APPLICATION_STATUS_LABELS,
  type BoardApplicationStatus,
} from '@/packages/common/forum';
import { formatDateTimeOr } from '@/packages/common/time';
import { ForumApplicationReview } from '@/components/forum-application-review';

export const dynamic = 'force-dynamic';

const STATUSES: BoardApplicationStatus[] = ['pending', 'approved', 'rejected'];

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function AdminForumPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/admin/forum');
  if (!isAdmin(ctx)) notFound();

  const sp = await searchParams;
  const raw = firstValue(sp.status);
  const status = STATUSES.includes(raw as BoardApplicationStatus)
    ? (raw as BoardApplicationStatus)
    : 'pending';

  const queue = await createForumBoardApplicationService({ db }).listQueue(ctx, { status });

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href="/admin">← 返回后台</Link>
      </p>
      <h1>讨论区 · 分区申请</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {STATUSES.map((key) => (
          <Link
            key={key}
            href={'/admin/forum' + (key === 'pending' ? '' : '?status=' + key)}
            className={status === key ? 'tag site' : 'tag'}
          >
            {BOARD_APPLICATION_STATUS_LABELS[key]}
          </Link>
        ))}
      </div>

      {queue.items.length === 0 ? (
        <p className="empty">没有{BOARD_APPLICATION_STATUS_LABELS[status]}的申请。</p>
      ) : (
        <ul className="item-list">
          {queue.items.map((app) => (
            <li key={app.applicationId} className="item" style={{ display: 'block' }}>
              <div className="item-body">
                <h3>
                  {app.name}
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                    /{app.slug}
                  </span>
                </h3>
                <div className="list-meta">
                  <span>申请人：{app.applicantNickname}</span>
                  <span>{formatDateTimeOr(app.createdAt, '未知')}</span>
                </div>
                {app.description ? (
                  <p style={{ margin: '6px 0', fontSize: 13 }}>{app.description}</p>
                ) : null}
                <p style={{ margin: '6px 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                  <strong>申请理由：</strong>
                  {app.reason}
                </p>
                {app.reviewNote ? (
                  <p className="muted" style={{ margin: '6px 0', fontSize: 13 }}>
                    审核意见：{app.reviewNote}
                  </p>
                ) : null}
                {app.status === 'pending' ? <ForumApplicationReview applicationId={app.applicationId} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>
        <Link href="/forum">去讨论区看看</Link>
      </p>
    </div>
  );
}
