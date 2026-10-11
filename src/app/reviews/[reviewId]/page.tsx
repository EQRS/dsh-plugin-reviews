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
import { commentsService } from '@/server/modules/comments';
import { formatVersionLabel } from '@/packages/common/status-text';
import type { VersionValue } from '@/packages/common/field-rules';

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
  first_published_at: number | null;
  public_updated_at: number | null;
}

export default async function ReviewDetailPage({ params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  const db = getDb();

  const vis = resolveVisibilityInTx(db, reviewId);
  if (!vis.publiclyVisible) {
    return (
      <div>
        <h1 style={{ fontSize: 22 }}>该评测当前不可查看</h1>
        <p style={{ color: '#526174' }}>
          {vis.withdrawn ? '作者已撤回这篇评测。' : vis.hidden ? '这篇评测已被隐藏。' : '这篇评测尚未发布。'}
        </p>
        <Link href="/reviews" style={{ color: '#2456B8' }}>
          ← 返回评测列表
        </Link>
      </div>
    );
  }

  const row = db
    .prepare(
      `SELECT r.id AS review_id, r.plugin_id, r.source_kind, rev.title, rev.body_markdown,
              rev.plugin_version, rev.dsh_version, u.nickname AS author_nickname,
              ce.first_published_at, ce.public_updated_at
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN users u ON u.id = ce.author_id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        WHERE r.id = ?`,
    )
    .get(reviewId) as Row | undefined;
  if (!row) notFound();

  const comments = await commentsService.listRootComments(reviewId, { page: 1, page_size: 20 }, db);

  const pluginVersion = JSON.parse(row.plugin_version) as VersionValue;
  const dshVersion = JSON.parse(row.dsh_version) as VersionValue;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 24 }}>
      <article style={{ background: '#FFFFFF', border: '1px solid #DBE1EA', borderRadius: 10, padding: 20 }}>
        <h1 style={{ fontSize: 26, marginTop: 0 }}>{row.title}</h1>
        <p style={{ color: '#526174', fontSize: 14, marginTop: 0 }}>
          <span
            style={{
              background: row.source_kind === 'site' ? '#EEF3FF' : '#F3F5F8',
              borderRadius: 4,
              padding: '1px 6px',
              marginRight: 8,
            }}
          >
            {row.source_kind === 'site' ? '站点评测' : '社区评测'}
          </span>
          {formatVersionLabel('插件', pluginVersion)} · {formatVersionLabel('DSH', dshVersion)} · {row.author_nickname}
        </p>
        <div style={{ whiteSpace: 'pre-wrap', maxWidth: 800 }}>{row.body_markdown}</div>

        <section style={{ marginTop: 32, borderTop: '1px solid #DBE1EA', paddingTop: 16 }}>
          <h2 style={{ fontSize: 18 }}>评论（{comments.total}）</h2>
          {comments.items.length === 0 ? (
            <p style={{ color: '#526174' }}>还没有评论。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {comments.items.map((c) => (
                <li key={c.commentId} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 14, color: '#526174' }}>
                    {c.authorId}
                    {c.firstPublishedAt === null
                      ? ' · 尚未公开'
                      : ` · ${new Date(c.firstPublishedAt).toLocaleString('zh-CN')}`}
                    {c.replyCount > 0 ? ` · ${c.replyCount} 条回复` : ''}
                  </div>
                  <div>
                    {c.deletedAt !== null ? '该评论已删除' : c.publishedRevisionId === null ? '该评论尚未公开' : c.body}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p style={{ color: '#526174', fontSize: 14 }}>
            提交评论需登录；接口见 <code>POST /api/content/{reviewId}/comments</code>。
          </p>
        </section>
      </article>

      <aside>
        <div style={{ background: '#FFFFFF', border: '1px solid #DBE1EA', borderRadius: 10, padding: 16 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>结构化版本</h2>
          <p style={{ fontSize: 14, color: '#526174' }}>
            被测插件版本：{formatVersionLabel('插件', pluginVersion)}
            <br />
            被测 DSH 版本：{formatVersionLabel('DSH', dshVersion)}
            <br />
            首次发布：
            {row.first_published_at === null ? '未知' : new Date(row.first_published_at).toLocaleString('zh-CN')}
            <br />
            最近更新：
            {row.public_updated_at === null ? '未知' : new Date(row.public_updated_at).toLocaleString('zh-CN')}
          </p>
          <p style={{ fontSize: 13, color: '#526174' }}>版本标签只表示作者记录的被测对象，不是兼容性承诺。</p>
          {row.plugin_id ? (
            <Link href={`/plugins/${row.plugin_id}`} style={{ color: '#2456B8', fontSize: 14 }}>
              ← 返回插件页
            </Link>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
