/**
 * 后台（页面布局.md 第 11 节的最小版）。
 *
 * 本轮补两块（都是"后端已就绪、界面问不出来"的能力）：
 *  1. **站点状态**：直接读 `platform/health` 的同一份报告（`GET /api/health` 的完整明细
 *     需要 `x-health-token`，公网只回三个字段；管理员在站内该看到全量），
 *     并**把 worker 心跳计入结论** —— worker 不跑，提交就不会被发布，这是管理员最该知道的一件事；
 *  2. **按处理阶段查提交**：`content_submissions.processing_state` 有 7 个取值，
 *     此前界面只能看到混在一起的 3 个"在流程中"的状态，**已发布/已通过/失去资格的历史完全看不见**。
 *     现在给出阶段选择器（默认仍是待办口径，与后端 `?state=` 的语义对齐）。
 */

import Link from 'next/link';
import { getDb, resolveDbPath } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { AdminDecisionForm } from '@/components/admin-decision-form';
import { AdminSettingsForm } from '@/components/admin-settings-form';
import { AdminDiscoveryPanel } from '@/components/admin-discovery-panel';
import { AdminUserPanel } from '@/components/admin-user-panel';
import { buildHealthReport } from '@/server/platform/health';
import { submissionStateLabels } from '@/packages/common/status-text';
import type { SubmissionState } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

/** 全部处理阶段（与 `content_submissions` 的 CHECK 及 `GET /api/admin/submissions?state=` 同源）。 */
const ALL_STATES: readonly SubmissionState[] = [
  'pending',
  'checking',
  'needs_changes',
  'manual_review',
  'approved',
  'published',
  'ineligible',
];

/** 默认视图＝待办口径：人工要处理的 + 正在流程中的（与页面原有口径一致）。 */
const TODO_STATES: readonly SubmissionState[] = ['manual_review', 'pending', 'needs_changes'];

interface Row {
  submission_id: string;
  processing_state: SubmissionState;
  state_version: number;
  submitted_at: number;
  submitter_nickname: string;
  review_title: string | null;
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const ctx = await currentContext();

  if (!isAdmin(ctx)) {
    return (
      <div>
        <h1>后台</h1>
        <p className="muted">
          需要管理员身份。当前
          {ctx.userId === null ? '未登录' : '登录账户不是管理员'}。
        </p>
        <p className="muted">
          管理员由**现有管理员**在本页下方「用户管理」里授予/撤销；站内仍然**没有自我提权**的入口
          （否则谁能把自己变成管理员就是漏洞）。
          第一任管理员只能上机指定：在项目根目录执行
          <code>node scripts/grant-admin.mjs --github-login &lt;GitHub 账号&gt;</code>
          —— 该账号需要先在站内登录过一次。<code>--list</code> 可查看现有用户与管理员。
        </p>
      </div>
    );
  }

  const db = getDb();
  const requested = (await searchParams).state;
  const selected: SubmissionState | null = ALL_STATES.includes(requested as SubmissionState)
    ? (requested as SubmissionState)
    : null;

  const baseSelect = `SELECT s.id AS submission_id, s.processing_state, s.state_version, s.submitted_at,
                             u.nickname AS submitter_nickname, rev.title AS review_title
                        FROM content_submissions s
                        JOIN users u ON u.id = s.submitted_by
                       LEFT JOIN review_revisions rev ON rev.id = s.review_revision_id`;

  const rows = (
    selected === null
      ? db
          .prepare(
            `${baseSelect}
              WHERE s.processing_state IN (${TODO_STATES.map(() => '?').join(', ')})
              ORDER BY s.submitted_at ASC, s.id ASC`,
          )
          .all(...TODO_STATES)
      : db
          .prepare(`${baseSelect} WHERE s.processing_state = ? ORDER BY s.submitted_at DESC, s.id DESC`)
          .all(selected)
  ) as Row[];

  // 站点状态：与 /api/health 同一份报告（requireWorker 让 worker 心跳计入结论）。
  const health = buildHealthReport(db, {
    now: Date.now(),
    dbFile: resolveDbPath(process.env.DSH_REVIEW_DB_PATH),
    requireWorker: true,
  });
  const workerText =
    health.worker.state === 'ok'
      ? `正常（${Math.round((health.worker.age_ms ?? 0) / 1000)} 秒前）`
      : health.worker.state === 'stale'
        ? '卡住（心跳陈旧）'
        : health.worker.state === 'dead'
          ? '疑似已死'
          : '从未写过心跳';
  const statusText = health.status === 'ok' ? '正常' : health.status === 'fail' ? '故障' : '降级';
  // 三种结论三种颜色：正常=强调色、降级=琥珀、故障=红（文字本身也已写明，不靠颜色单独表意）
  const statusClass =
    health.status === 'ok' ? 'tag site' : health.status === 'fail' ? 'tag danger' : 'tag warn';
  // 磁盘余量按 GB 显示（MB 六位数既长又难判读）
  const diskText =
    health.disk.free_mb === null
      ? '未检查（未给出库文件路径）'
      : health.disk.free_mb >= 1024
        ? `${(health.disk.free_mb / 1024).toFixed(1)} GB`
        : `${health.disk.free_mb} MB`;

  return (
    <div>
      <h1>待处理事项</h1>

      {/* 阶段选择器：默认「待办」（3 态混合），可切到任一阶段看历史。 */}
      <div className="filters" style={{ marginTop: 12 }}>
        <span className="group-label">阶段</span>
        <Link href="/admin" className={selected === null ? 'active' : ''}>
          待办
        </Link>
        {ALL_STATES.map((s) => (
          <Link key={s} href={`/admin?state=${s}`} className={selected === s ? 'active' : ''}>
            {submissionStateLabels[s]}
          </Link>
        ))}
      </div>

      <p className="muted">
        共 {rows.length} 条
        {selected === null ? '（待办口径：等待人工处理 + 正在流程中）' : `（阶段：${submissionStateLabels[selected]}）`}
      </p>
      {rows.length === 0 ? (
        <p className="empty">
          当前没有
          {selected === null ? '待处理事项' : `处于「${submissionStateLabels[selected]}」的提交`}。
        </p>
      ) : (
        <div className="panel">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                <th style={{ padding: 8 }}>标题</th>
                <th style={{ padding: 8 }}>提交者</th>
                <th style={{ padding: 8 }}>阶段</th>
                <th style={{ padding: 8 }}>提交时间</th>
                <th style={{ padding: 8 }}>决定</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.submission_id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: 8 }}>{r.review_title ?? '(无标题)'}</td>
                  <td style={{ padding: 8 }}>{r.submitter_nickname}</td>
                  <td style={{ padding: 8 }}>{submissionStateLabels[r.processing_state]}</td>
                  <td className="muted" style={{ padding: 8 }}>
                    {formatDateTime(r.submitted_at)}
                  </td>
                  <td style={{ padding: 8 }}>
                    {/*
                      只对 manual_review 给决定按钮：
                       - pending / checking 还没被检查过，人工决定会**跳过规则校验**；
                       - needs_changes 等的是作者改稿，不是管理员再决定。
                      这两类如实说明，不摆一个点了也不对的按钮。
                    */}
                    {r.processing_state === 'manual_review' ? (
                      <AdminDecisionForm submissionId={r.submission_id} stateVersion={r.state_version} />
                    ) : (
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                        {r.processing_state === 'pending' || r.processing_state === 'checking'
                          ? '等待检查任务处理，无需人工决定。'
                          : r.processing_state === 'needs_changes'
                            ? '等待作者修改后重新提交。'
                            : '已结束的提交，只作记录查看。'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        「通过并发布」会走 <code>workflows/decide-submission</code>：写决定记录 + 把状态推到
        <code>approved</code>，**并同时入队一条发布任务**。任务类型按提交类型选 ——
        评测提交入队 <code>review_publish</code>，评论提交入队 <code>comment_publish</code>
        （本列表里两类混在一起，都是待人工处理）。去重键与自动检查通过时完全一致，因此不会重复发布。
        真正的发布由 worker 执行 —— <strong>worker 没在跑，内容就不会公开</strong>。
      </p>

      {/* 站点状态：管理员视角的完整健康报告（公网 /api/health 只回三个字段）。 */}
      <section className="panel" style={{ marginTop: 24 }}>
        <div className="section-head">
          <h2>站点状态</h2>
          <span className={statusClass}>{statusText}</span>
        </div>
        <div className="list-meta" style={{ marginBottom: 12 }}>
          <span>库结构版本：{health.schema_version ?? '未知'}</span>
          <span>检查时间：{formatDateTime(health.checked_at)}</span>
          <span>worker 心跳：{workerText}</span>
          <span>磁盘余量：{diskText}</span>
        </div>
        {/* 检查项：紧凑一行一项（这是诊断清单，不是内容列表，不需要 .item 的行高） */}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
          {health.checks.map((c) => (
            <li key={c.name} style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <code style={{ color: 'var(--accent)', fontSize: 13 }}>{c.name}</code>
              <span style={{ fontSize: 13, color: c.ok ? 'var(--muted)' : 'var(--danger)' }}>
                {c.ok ? '通过' : '异常'}
                {c.detail ? ` · ${c.detail}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
          这份报告与 <code>GET /api/health?worker=1</code> 同源，区别是它**不做业务统计**（不数用户/评测/评论），
          也不含任何凭据。这里把 worker 心跳计入结论：worker 停着而 web 正常，是"看着没事、其实内容发不出去"的典型状态。
        </p>
      </section>

      <Link href="/" style={{ fontSize: 14 }}>
        ← 返回首页
      </Link>

      {/* 后台栏目：`idea.md §23` 规划 8 组，目前做到 5 组（待办 / 站点状态 / 任务与同步 / 业务设置 / 用户管理）。
          顺序按"管理员日常先看什么"排：先看同步有没有跑、再改参数、最后管人。 */}
      <AdminDiscoveryPanel />
      <AdminSettingsForm />
      <AdminUserPanel />
    </div>
  );
}