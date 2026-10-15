/**
 * 评测文章页（页面布局.md 第 6 节）：正文主栏 + 版本明确。
 *
 * 只显示**当前公开修订**；撤回/隐藏时给出允许告知的状态，不返回正文。
 * 评论区读取公开顶层讨论组。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { formatVersionLabel } from '@/packages/common/status-text';
import { renderMarkdownToSafeHtml } from '@/server/platform/markdown';
import { currentContext } from '@/app/api/_lib/context';
import { CommentSection } from '@/components/comment-section';
import { WithdrawButton } from '@/components/withdraw-button';
import type { VersionValue } from '@/packages/common/field-rules';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface Row {
  review_id: string;
  plugin_id: string | null;
  source_kind: 'community' | 'site';
  title: string;
  body_markdown: string;
  plugin_version: string;
  dsh_version: string;
  author_nickname: string;
  author_id: string;
  first_published_at: number | null;
  public_updated_at: number | null;
}

export default async function ReviewDetailPage({ params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  const db = getDb();

  // 作者视角需要"这是不是我的文章"；服务端已经解析过会话，这里只读不多查库。
  const ctx = await currentContext();

  const vis = resolveVisibilityInTx(db, reviewId);
  if (!vis.publiclyVisible) {
    return (
      <div>
        <h1>该评测当前不可查看</h1>
        <p className="muted">
          {vis.withdrawn ? '作者已撤回这篇评测。' : vis.hidden ? '这篇评测已被隐藏。' : '这篇评测尚未发布。'}
        </p>
        <Link href="/reviews">
          ← 返回评测列表
        </Link>
      </div>
    );
  }

  const row = db
    .prepare(
      `SELECT r.id AS review_id, r.plugin_id, r.source_kind, rev.title, rev.body_markdown,
              rev.plugin_version, rev.dsh_version, u.nickname AS author_nickname, ce.author_id,
              ce.first_published_at, ce.public_updated_at
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN users u ON u.id = ce.author_id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        WHERE r.id = ?`,
    )
    .get(reviewId) as Row | undefined;
  if (!row) notFound();

  const pluginVersion = JSON.parse(row.plugin_version) as VersionValue;
  const dshVersion = JSON.parse(row.dsh_version) as VersionValue;

  // 正文经统一管线渲染并**净化**（架构第 25 节）。HTML 是可重建的展示结果，
  // Markdown 原文才是权威内容；这里只做展示，不回写任何数据。
  const safeBodyHtml = renderMarkdownToSafeHtml(row.body_markdown);

  return (
    <div className="twocol read-layout">
      <article className="panel">
        <h1 style={{ marginBottom: 8 }}>{row.title}</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          <span
            className={row.source_kind === 'site' ? 'tag site' : 'tag'}
            style={{ marginRight: 8 }}
          >
            {row.source_kind === 'site' ? '站点评测' : '社区评测'}
          </span>
          {formatVersionLabel('插件', pluginVersion)} · {formatVersionLabel('DSH', dshVersion)} · {row.author_nickname}
        </p>
        {/*
          渲染后的正文。内容已经过 rehype-sanitize，脚本/事件属性/危险协议都被清除；
          这里刻意不使用 whiteSpace:pre-wrap（那样会把 Markdown 标记原样显示）。
        */}
        <div
          className="review-body"
          style={{ maxWidth: 800, lineHeight: 1.75 }}
          dangerouslySetInnerHTML={{ __html: safeBodyHtml }}
        />

        {/*
          评论区改为客户端组件：列表照旧读公开讨论组，但登录态与"发表评论"
          必须走真实接口（GET/POST /api/content/{id}/comments）。
          服务端不再预取列表 —— 否则发完评论要整页刷新才能看到。
        */}
        <CommentSection contentId={reviewId} />
      </article>

      <aside>
        <div className="panel">
          <h2 style={{ marginBottom: 8 }}>结构化版本</h2>
          <p className="muted">
            被测插件版本：{formatVersionLabel('插件', pluginVersion)}
            <br />
            被测 DSH 版本：{formatVersionLabel('DSH', dshVersion)}
            <br />
            首次发布：
            {row.first_published_at === null ? '未知' : formatDateTime(row.first_published_at)}
            <br />
            最近更新：
            {row.public_updated_at === null ? '未知' : formatDateTime(row.public_updated_at)}
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>版本标签只表示作者记录的被测对象，不是兼容性承诺。</p>
          {row.plugin_id ? (
            <Link href={`/plugins/${row.plugin_id}`} style={{ fontSize: 14 }}>
              ← 返回插件页
            </Link>
          ) : null}
        </div>

        {/*
          作者操作只在**作者本人**看这篇时出现。撤回资格由服务端核验（非作者一律 403），
          这里隐藏按钮只是不摆一个点了也没用的入口，不是权限判断。
        */}
        {ctx.userId !== null && ctx.userId === row.author_id ? (
          <div className="panel" style={{ marginTop: 12 }}>
            <h2 style={{ marginBottom: 8 }}>作者操作</h2>
            <WithdrawButton reviewId={row.review_id} expectedControlVersion={vis.controlVersion} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}