/**
 * 问题反馈（纯私有）：提交表单 + 我的反馈列表。
 *
 * 入口只对登录用户可见（提交必须登录）；未登录访问会被送去登录页。
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { isAuthenticated } from '@/server/platform/context';
import { booleanSetting } from '@/server/modules/settings';
import { createFeedbackService, FEEDBACK_KIND_LABELS, FEEDBACK_STATUS_LABELS } from '@/server/modules/feedback';
import { FeedbackForm } from '@/components/feedback-form';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  // 开关关闭时整页当作不存在（与接口 404 同口径，避免露出半截功能）
  if (!booleanSetting(db, 'feedback.enabled', true)) notFound();

  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/feedback');

  const sp = await searchParams;
  const from = (firstValue(sp.from) ?? '').trim().slice(0, 1000);
  const defaultPageUrl = from.startsWith('/') && !from.startsWith('//') ? from : '';

  const service = createFeedbackService({ db });
  const mine = await service.listMine(ctx, { page: 1, pageSize: 20 });

  return (
    <div>
      <h1>反馈问题</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        报告站点自身的问题。内容违规请用内容页的「举报」，插件资料写错请用插件页的「纠错」，
        对整合包下架有异议请用版本页的「申诉」——这四条通道各管一类，走对了处理更快。
      </p>

      <section className="panel">
        <div className="section-head">
          <h2>提交</h2>
        </div>
        <FeedbackForm defaultPageUrl={defaultPageUrl} />
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="section-head">
          <h2>我的反馈（{mine.total}）</h2>
        </div>
        {mine.items.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            还没有提交过反馈。
          </p>
        ) : (
          <ul className="item-list">
            {mine.items.map((t) => (
              <li key={t.id} className="item">
                <div className="item-body">
                  <h3 className="item-title">
                    <Link href={'/feedback/' + t.id}>{t.title}</Link>
                  </h3>
                  <div className="list-meta">
                    <span className={t.status === 'open' ? 'tag warn' : 'tag site'}>
                      {FEEDBACK_STATUS_LABELS[t.status]}
                    </span>
                    <span>{FEEDBACK_KIND_LABELS[t.kind]}</span>
                    <span>提交于 {formatDateTimeOr(t.createdAt, '未知')}</span>
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
