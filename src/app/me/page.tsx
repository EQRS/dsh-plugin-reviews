/**
 * 我的（个人中心最小版）：本人草稿与提交状态。
 *
 * 只做"我的评测草稿 + 提交阶段"一块；收藏、通知、事项属本切片范围外。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { currentContext } from '../api/_lib/context';
import { submissionStateLabels } from '@/packages/common/status-text';
import type { SubmissionState } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface DraftRow {
  draft_id: string;
  review_id: string;
  save_version: number;
  saved_at: number;
  title: string | null;
}

interface SubRow {
  submission_id: string;
  processing_state: SubmissionState;
  submitted_at: number;
}

export default async function MePage() {
  const ctx = await currentContext();
  if (ctx.userId === null) {
    return (
      <div>
        <h1>我的</h1>
        <p className="muted">
          需要登录。本切片未接入真实 GitHub OAuth；开发环境可用{' '}
          <code>POST /api/session</code>（携 providerUserId / providerUsername）建立测试会话。
        </p>
      </div>
    );
  }

  const db = getDb();
  const drafts = db
    .prepare(
      `SELECT d.id AS draft_id, d.review_id, d.save_version, d.saved_at, rev.title
         FROM content_drafts d
         LEFT JOIN review_revisions rev ON rev.review_id = d.review_id
        WHERE d.owner_id = ?
        GROUP BY d.id
        ORDER BY d.saved_at DESC, d.id DESC`,
    )
    .all(ctx.userId) as DraftRow[];

  const subs = db
    .prepare(
      `SELECT id AS submission_id, processing_state, submitted_at
         FROM content_submissions
        WHERE submitted_by = ?
        ORDER BY submitted_at DESC, id DESC`,
    )
    .all(ctx.userId) as SubRow[];

  return (
    <div>
      <h1>我的评测</h1>

      {/*
        写评测的入口在插件页（页面布局.md 第 5 节：插件详情的主要操作含"写评测"）。
        这里**不能**凭空建草稿：不带 pluginId 的草稿在提交时会因 plugin_id 未绑定被拒
        （见 validateForPublish 与 review_revisions.plugin_id NOT NULL），点到最后必然失败。
      */}
      <p style={{ marginTop: 12, fontSize: 14 }}>
        <Link href="/plugins">
          写一篇评测
        </Link>
        <span className="muted"> —— 先在插件目录选一个插件，从它的详情页进入编辑器。</span>
      </p>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="section-head">
          <h2>草稿（{drafts.length}）</h2>
        </div>
        {drafts.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            暂无草稿。到插件页点「写一篇评测」开始。
          </p>
        ) : (
          <ul className="item-list">
            {drafts.map((d) => (
              <li key={d.draft_id} className="item">
                <div className="item-body">
                  <div style={{ fontWeight: 600 }}>
                    <Link href={`/me/drafts/${d.draft_id}`}>
                      {d.title && d.title.trim() !== '' ? d.title : '(尚未填写标题)'}
                    </Link>
                  </div>
                  <div className="muted">
                    草稿 <code>{d.draft_id}</code> · 保存版本 {d.save_version} ·{' '}
                    {formatDateTime(d.saved_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="section-head">
          <h2>提交记录（{subs.length}）</h2>
        </div>
        {subs.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            暂无提交。
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {subs.map((s) => (
              <li key={s.submission_id} style={{ marginBottom: 8 }}>
                <code>{s.submission_id}</code> · {submissionStateLabels[s.processing_state]} ·{' '}
                {formatDateTime(s.submitted_at)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted" style={{ marginTop: 24 }}>
        公开状态与提交阶段分别表达：提交显示"已发布"不代表内容当前仍公开（撤回/隐藏另行判断）。
      </p>
    </div>
  );
}