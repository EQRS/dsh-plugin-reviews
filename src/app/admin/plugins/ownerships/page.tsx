/**
 * 管理员 · 插件认领审核队列。
 *
 * 数据来源是服务层的 `listQueue`，页面自己**不写 SQL**：
 * 「待审」的口径（status='pending'）、排序（先来先审）、
 * 以及「谁的插件 / 什么仓库」这些字段的拼装都在 ownership.ts 里，
 * 抄一份到页面上就会两边不同步（比如以后列表多带一个字段，页面还停在旧口径）。
 *
 * 权限：非管理员直接 redirect('/')，与 /admin/packs、/admin/feedback 一致——
 * 后台页面不向非管理员"如实说明"入口在哪，那等于把后台结构公开给了所有人。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { createPluginOwnershipService } from '@/server/modules/roles/ownership';
import type { OwnershipQueueItem, OwnershipStatus } from '@/server/modules/roles/ownership';
import { AdminReviewForm } from '@/components/admin-review-form';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

/** 状态页签：只开放「待审」与「已处理」，不做一个没有实际用处的全量浏览页。 */
const TABS: { key: 'pending' | 'all'; label: string; hint: string }[] = [
  { key: 'pending', label: '待审', hint: '等待管理员核实归属的认领' },
  { key: 'all', label: '全部', hint: '含已通过与被驳回的认领（只作记录查看）' },
];

function statusLabel(status: OwnershipStatus): string {
  return status === 'pending' ? '待审' : status === 'verified' ? '已通过' : '已驳回';
}

export default async function AdminOwnershipsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status: OwnershipStatus | 'all' = raw === 'all' ? 'all' : 'pending';

  const service = createPluginOwnershipService({ db: getDb() });
  const rows: OwnershipQueueItem[] = await service.listQueue(ctx, status);

  return (
    <div>
      <div className="section-head">
        <h1 style={{ margin: 0 }}>插件认领审核</h1>
        <Link href="/admin">← 返回管理后台</Link>
      </div>

      <div className="filters" style={{ marginTop: 8 }}>
        {TABS.map((tab) => (
          <Link key={tab.key} href={`/admin/plugins/ownerships?status=${tab.key}`} className={status === tab.key ? 'active' : ''}>
            {tab.label}
          </Link>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 8 }}>
        {status === 'pending'
          ? '仓库 owner 与用户的 GitHub 账号对得上时系统会自动通过，不进这个队列；这里只有需要人工核实的认领（例如仓库属于组织、或申请人是协作者而非 owner）。'
          : '已处理过的认领，只作记录查看。被驳回的用户可以补充证据后重新认领。'}
      </p>

      <section className="panel" style={{ marginTop: 12 }}>
        <div className="section-head">
          <h2>共 {rows.length} 条</h2>
        </div>
        {rows.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            {status === 'pending' ? '暂无待审认领。' : '还没有处理过的认领记录。'}
          </p>
        ) : (
          <ul className="item-list">
            {rows.map((row) => (
              <li key={row.ownershipId} className="item">
                <div className="item-body">
                  <div className="item-head">
                    <span className={row.ownershipStatus === 'pending' ? 'tag warn' : 'tag site'}>
                      {statusLabel(row.ownershipStatus)}
                    </span>
                    <div className="item-main">
                      <h3 className="item-title">
                        {row.displayName ?? row.repositoryFullName}
                        {row.isArchived ? '（仓库已归档）' : ''}
                      </h3>
                      <div className="list-meta">
                        <span>申请人 {row.userNickname}</span>
                        <span>仓库 {row.repositoryFullName}</span>
                        {row.ownerLogin ? <span>仓库 owner {row.ownerLogin}</span> : null}
                        <span>插件路径 {row.pluginPath}</span>
                        <span>{formatDateTimeOr(row.createdAt, '时间未知')}</span>
                      </div>
                    </div>
                  </div>

                  <p className="muted" style={{ margin: '6px 0' }}>
                    认领说明：{row.claimedNote ?? <span>（未填写）</span>}
                  </p>

                  {row.ownershipStatus === 'pending' ? (
                    <AdminReviewForm
                      endpoint={`/api/admin/plugin-ownerships/${encodeURIComponent(row.ownershipId)}`}
                      rejectPlaceholder="驳回理由（必填，申请人会在「我的插件」里看到这句话）"
                      rejectNoteLabel="驳回理由"
                    />
                  ) : (
                    <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
                      已处理，无需再操作。
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted" style={{ marginTop: 12 }}>
        通过后该插件记在这位用户名下，并计入「开发者」身份的资格判定。
        <strong>一个插件同时只能有一位已验证归属人</strong>——如果插件已经有归属人，通过操作会被拒绝并提示先处理那一条。
      </p>
    </div>
  );
}
