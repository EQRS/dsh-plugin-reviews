/**
 * 后台（页面布局.md 第 11 节的最小版）：统一待办列表。
 *
 * 只做"人工审核待办"一块；其余业务栏目属本切片范围外。
 * 非管理员显示明确的无权访问状态，不泄露内部材料。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { isAdmin } from '@/server/platform/context';
import { AdminDecisionForm } from '@/components/admin-decision-form';
import { AdminSettingsForm } from '@/components/admin-settings-form';
import { AdminDiscoveryPanel } from '@/components/admin-discovery-panel';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface Row {
  submission_id: string;
  processing_state: string;
  state_version: number;
  submitted_at: number;
  submitter_nickname: string;
  review_title: string | null;
}

export default async function AdminPage() {
  const ctx = await currentContext();

  if (!isAdmin(ctx)) {
    return (
      <div>
        <h1 style={{ fontSize: 22 }}>后台</h1>
        <p style={{ color: '#526174' }}>
          需要管理员身份。当前
          {ctx.userId === null ? '未登录' : '登录账户不是管理员'}。
        </p>
        <p style={{ color: '#526174', fontSize: 14 }}>
          管理员由部署者指定，站内**没有**自我提权的入口（否则谁能把自己变成管理员就是漏洞）。
          在项目根目录执行：<code>node scripts/grant-admin.mjs --github-login &lt;GitHub 账号&gt;</code>
          —— 该账号需要先在站内登录过一次。<code>--list</code> 可查看现有用户与管理员。
        </p>
      </div>
    );
  }

  const rows = getDb()
    .prepare(
      `SELECT s.id AS submission_id, s.processing_state, s.state_version, s.submitted_at,
              u.nickname AS submitter_nickname, rev.title AS review_title
         FROM content_submissions s
         JOIN users u ON u.id = s.submitted_by
         LEFT JOIN review_revisions rev ON rev.id = s.review_revision_id
        WHERE s.processing_state IN ('manual_review','pending','needs_changes')
        ORDER BY s.submitted_at ASC, s.id ASC`,
    )
    .all() as Row[];

  return (
    <div>
      <h1 style={{ fontSize: 22 }}>待处理事项</h1>
      <p style={{ color: '#526174' }}>共 {rows.length} 条</p>
      {rows.length === 0 ? (
        <p style={{ color: '#526174' }}>当前没有待处理事项。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#FFFFFF' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #DBE1EA' }}>
              <th style={{ padding: 8 }}>标题</th>
              <th style={{ padding: 8 }}>提交者</th>
              <th style={{ padding: 8 }}>阶段</th>
              <th style={{ padding: 8 }}>提交时间</th>
              <th style={{ padding: 8 }}>决定</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.submission_id} style={{ borderBottom: '1px solid #DBE1EA' }}>
                <td style={{ padding: 8 }}>{r.review_title ?? '(无标题)'}</td>
                <td style={{ padding: 8 }}>{r.submitter_nickname}</td>
                <td style={{ padding: 8 }}>{r.processing_state}</td>
                <td style={{ padding: 8, fontSize: 14, color: '#526174' }}>
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
                    <span style={{ fontSize: 13, color: '#526174' }}>
                      {r.processing_state === 'pending'
                        ? '等待检查任务处理，无需人工决定。'
                        : '等待作者修改后重新提交。'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ marginTop: 16, fontSize: 14, color: '#526174' }}>
        「通过并发布」会走 <code>workflows/decide-submission</code>：写决定记录 + 把状态推到
        <code>approved</code>，**并同时入队一条发布任务**。任务类型按提交类型选 ——
        评测提交入队 <code>review_publish</code>，评论提交入队 <code>comment_publish</code>
        （本列表里两类混在一起，都是待人工处理）。去重键与自动检查通过时完全一致，因此不会重复发布。
        真正的发布由 worker 执行 —— <strong>worker 没在跑，内容就不会公开</strong>。
      </p>
      <Link href="/" style={{ color: '#2456B8', fontSize: 14 }}>
        ← 返回首页
      </Link>

      {/* 另外两组：`idea.md §23` 规划 8 组，目前做到 3 组（待办 / 任务与同步 / 业务设置）。
          顺序按"管理员日常先看什么"排：先看同步有没有跑、再改参数。 */}
      <AdminDiscoveryPanel />
      <AdminSettingsForm />
    </div>
  );
}
