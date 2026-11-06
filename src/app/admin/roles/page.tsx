/**
 * 管理员 · 身份申请审核队列（测评员 / 开发者）。
 *
 * 数据来源是身份服务 `listApplicationsForAdmin`（设计文档 §5.2）。页面不直连数据库：
 * 「什么算待审」「evidence 快照怎么呈现」属于身份服务，页面只负责把它画出来。
 *
 * 与认领队列的区别：认领审的是「这个插件是不是他的」，申请审的是「他有资格吗」。
 * 所以这里必须把 **evidence 资格快照**原样摊开给管理员看——申请那一刻的数字已经定死，
 * 审核时不再现算（§3.2 的理由：现算会让管理员看到与申请人不同的数字，容易起争议）。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { AdminReviewForm } from '@/components/admin-review-form';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

/** 与 0040 迁移 role_applications.status 的 CHECK 一致。 */
const TABS = [
  { key: 'pending', label: '待审' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' },
  { key: 'all', label: '全部' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const ROLE_LABELS: Record<string, string> = {
  reviewer: '测评员',
  developer: '开发者',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待审',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
};

/** 这一条申请「凭什么」，给管理员一眼就能读懂的一句话。 */
function evidenceLines(evidence: unknown): string[] {
  if (evidence === null || evidence === undefined) return ['（申请时未记录资格快照）'];
  const source = typeof evidence === 'string' ? safeJson(evidence) : evidence;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return [`（快照格式无法解读：${String(evidence).slice(0, 120)}）`];
  }
  const entries = Object.entries(source as Record<string, unknown>);
  if (entries.length === 0) return ['（资格快照为空）'];
  return entries.map(([key, value]) => `${EVIDENCE_LABELS[key] ?? key}：${formatEvidenceValue(value)}`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const EVIDENCE_LABELS: Record<string, string> = {
  published_reviews: '已发布测评',
  verified_plugins: '已验证归属插件',
  review_count: '已发布测评',
  plugin_count: '已验证归属插件',
  role_type: '申请身份',
  captured_at: '快照时间',
};

function formatEvidenceValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  if (value === null) return '—';
  return JSON.stringify(value);
}

interface ApplicationRow {
  id: string;
  userId: string;
  userNickname: string | null;
  roleType: string;
  status: string;
  evidence: unknown;
  note: string | null;
  reviewNote?: string | null;
  createdAt: number;
}

export default async function AdminRolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await currentContext();
  if (!isAdmin(ctx)) redirect('/');

  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : 'pending';

  let rows: ApplicationRow[] = [];
  let unavailable: string | null = null;
  try {
    const mod = await import('@/server/modules/roles/service');
    const service = mod.createRoleService({ db: getDb() });
    const result = await service.listApplicationsForAdmin(ctx, status);
    rows = (result as unknown as ApplicationRow[]).slice();
  } catch {
    // 身份服务未落地时这里必须**说清楚**，不能假装队列为空。
    unavailable = '身份服务尚未就绪（src/server/modules/roles/service.ts 未交付），本页暂时无法读取队列。';
  }

  return (
    <div>
      <div className="section-head">
        <h1 style={{ margin: 0 }}>身份申请审核</h1>
        <Link href="/admin">← 返回管理后台</Link>
      </div>

      <div className="filters" style={{ marginTop: 8 }}>
        {TABS.map((tab) => (
          <Link key={tab.key} href={`/admin/roles?status=${tab.key}`} className={status === tab.key ? 'active' : ''}>
            {tab.label}
          </Link>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 8 }}>
        测评员的条件是「至少一篇已发布的测评」，开发者的条件是「至少一个已验证归属的插件」。
        每份申请带着<strong>申请那一刻的资格快照</strong>——审核请按快照判断，不必回到用户主页现算
        （现算会与申请人看到的数字不一致）。
      </p>

      {unavailable !== null ? (
        <section className="panel" style={{ marginTop: 12 }}>
          <p className="muted" style={{ marginBottom: 0 }}>{unavailable}</p>
        </section>
      ) : (
        <section className="panel" style={{ marginTop: 12 }}>
          <div className="section-head">
            <h2>共 {rows.length} 条</h2>
          </div>
          {rows.length === 0 ? (
            <p className="empty" style={{ marginBottom: 0 }}>
              暂无待审申请。
            </p>
          ) : (
            <ul className="item-list">
              {rows.map((row) => {
                const isPending = row.status === 'pending';
                return (
                  <li key={row.id} className="item">
                    <div className="item-body">
                      <div className="item-head">
                        <span className={isPending ? 'tag warn' : 'tag site'}>
                          {STATUS_LABELS[row.status] ?? row.status}
                        </span>
                        <div className="item-main">
                          <h3 className="item-title">
                            {ROLE_LABELS[row.roleType] ?? row.roleType} 申请
                          </h3>
                          <div className="list-meta">
                            <span>申请人 {row.userNickname ?? '未知用户'}</span>
                            <span>提交于 {formatDateTimeOr(row.createdAt, '时间未知')}</span>
                          </div>
                        </div>
                      </div>

                      <div className="list-meta" style={{ marginTop: 4 }}>
                        {evidenceLines(row.evidence).map((line) => (
                          <span key={line}>{line}</span>
                        ))}
                      </div>

                      <p className="muted" style={{ margin: '6px 0' }}>
                        自述：{row.note !== null && row.note.trim().length > 0 ? row.note : '（未填写）'}
                      </p>

                      {isPending ? (
                        <AdminReviewForm
                          endpoint={`/api/admin/role-applications/${encodeURIComponent(row.id)}`}
                          decisionVerify="approve"
                          rejectPlaceholder="驳回理由（必填，会作为通知正文发给申请人）"
                          rejectNoteLabel="驳回理由"
                        />
                      ) : (
                        <p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>
                          {STATUS_LABELS[row.status] ?? row.status}
                          {row.reviewNote !== null && row.reviewNote !== undefined && row.reviewNote.trim().length > 0
                            ? `：${row.reviewNote}`
                            : '。已处理，无需再操作。'}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <p className="muted" style={{ marginTop: 12 }}>
        通过后系统会为该用户写入对应身份（同一用户可同时持有测评员与开发者，各自独立审核）。
        驳回必须写理由，理由会通知申请人；被驳回后需等冷却期结束才能再次申请。
      </p>
    </div>
  );
}
