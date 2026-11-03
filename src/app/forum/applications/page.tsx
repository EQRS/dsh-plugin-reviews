/**
 * 申请新建分区：/forum/applications
 *
 * 一页两用：上面是申请表，下面是「我的申请」及审核结果。
 * 理由必填 —— 审核要凭它判断这个分区有没有存在必要。
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { isAuthenticated } from '@/server/platform/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumBoardApplicationService } from '@/server/modules/forum/applications';
import { BOARD_APPLICATION_STATUS_LABELS } from '@/packages/common/forum';
import { formatDateTimeOr } from '@/packages/common/time';
import { ForumApplicationForm } from '@/components/forum-application-form';

export const dynamic = 'force-dynamic';

export default async function ForumApplicationsPage() {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/forum/applications');

  const mine = await createForumBoardApplicationService({ db }).listMine(ctx);

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href="/forum">← 返回讨论区</Link>
      </p>
      <h1>申请新建分区</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        审核通过后你会成为该分区区长，可以管理发帖权限、置顶与删除。请说明为什么需要这个分区。
      </p>

      <ForumApplicationForm />

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 17 }}>我的申请（{mine.length}）</h2>
        {mine.length === 0 ? (
          <p className="empty">还没有提交过申请。</p>
        ) : (
          <ul className="item-list">
            {mine.map((app) => (
              <li key={app.applicationId} className="item">
                <div className="item-body">
                  <h3>
                    {app.name}
                    <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                      /{app.slug}
                    </span>
                    <span
                      className={app.status === 'approved' ? 'tag site' : app.status === 'rejected' ? 'tag' : 'tag warn'}
                      style={{ marginLeft: 8 }}
                    >
                      {BOARD_APPLICATION_STATUS_LABELS[app.status]}
                    </span>
                  </h3>
                  <div className="list-meta">
                    <span>提交于 {formatDateTimeOr(app.createdAt, '未知')}</span>
                    {app.reviewedAt !== null ? <span>审核于 {formatDateTimeOr(app.reviewedAt, '未知')}</span> : null}
                  </div>
                  {app.reviewNote ? (
                    <p style={{ margin: '6px 0 0', fontSize: 13 }}>
                      <strong>审核意见：</strong>
                      {app.reviewNote}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
