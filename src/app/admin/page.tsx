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
          首个管理员在部署时按既定规则指定；本切片未提供后台授予入口。
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
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.submission_id} style={{ borderBottom: '1px solid #DBE1EA' }}>
                <td style={{ padding: 8 }}>{r.review_title ?? '(无标题)'}</td>
                <td style={{ padding: 8 }}>{r.submitter_nickname}</td>
                <td style={{ padding: 8 }}>{r.processing_state}</td>
                <td style={{ padding: 8, fontSize: 14, color: '#526174' }}>
                  {new Date(r.submitted_at).toLocaleString('zh-CN')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ marginTop: 16, fontSize: 14, color: '#526174' }}>
        决定接口：<code>POST /api/admin/submissions/{'{submissionId}'}/decisions</code>，需携原因、预期提交版本与请求去重键。
        发布动作见 <code>workflows/publish-review</code>（本切片由 worker/脚本触发）。
      </p>
      <Link href="/" style={{ color: '#2456B8', fontSize: 14 }}>
        ← 返回首页
      </Link>
    </div>
  );
}
