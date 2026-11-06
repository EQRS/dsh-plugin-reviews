/**
 * 帖子详情：正文（Markdown 净化渲染）+ 两层回复。
 *
 * 回复只有两层：顶层回复下挂其下的回复，不再往下嵌。回复的回复不显示图片入口。
 * 已删除的帖子仍可打开（作者与管理员需要看到痕迹），但内容区显示占位。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumPostService } from '@/server/modules/forum/posts';
import { renderMarkdownToSafeHtml } from '@/server/platform/markdown';
import { formatDateTimeOr } from '@/packages/common/time';
import { DomainError, ErrorCodes } from '@/packages/common/errors';
import { ReportButton } from '@/components/report-button';
import { ForumPostActions } from '@/components/forum-post-actions';
import { ForumReplyForm } from '@/components/forum-reply-form';

export const dynamic = 'force-dynamic';

export default async function ForumPostPage({
  params,
}: {
  params: Promise<{ slug: string; postId: string }>;
}) {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const { slug, postId } = await params;
  const ctx = await currentContext();
  const service = createForumPostService({ db });

  let post;
  try {
    post = await service.getPost(ctx, postId);
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw e;
  }
  if (post.boardSlug !== slug) notFound();

  const replies = await service.listReplies(ctx, postId);
  // 服务层对无权查看的正文（待审帖、已删帖）返回 bodyMd = null：
  // 这里不能再渲染，否则要么报类型错、要么把空串渲染成看起来「帖子没内容」。
  const bodyHtml = post.bodyMd === null ? '' : renderMarkdownToSafeHtml(post.bodyMd);
  const authenticated = ctx.userId !== null;

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href={'/forum/' + slug}>← 返回「{post.boardName}」</Link>
      </p>

      <article>
        <h1 style={{ marginBottom: 8 }}>
          {post.isPinned ? '📌 ' : ''}
          {post.title}
        </h1>
        <div className="list-meta" style={{ marginBottom: 16 }}>
          <span>{post.authorNickname}</span>
          <span>{formatDateTimeOr(post.createdAt, '未知')}</span>
          {post.editedAt !== null ? <span>编辑于 {formatDateTimeOr(post.editedAt, '未知')}</span> : null}
          <span>{post.likeCount} 赞</span>
          <span>{post.replyCount} 条回复</span>
        </div>

        {post.status === 'deleted' ? (
          <p className="notice">该帖已被作者或管理员删除。</p>
        ) : post.bodyMd === null ? (
          // 正文对当前访客不可见：待审帖只有作者与站方管理员看得到正文
          <p className="notice">该帖正在审核中，暂不对外显示。</p>
        ) : (
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        )}
      </article>

      <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
        {post.status === 'published' ? (
          <ReportButton targetKind="post" targetId={post.postId} authenticated={authenticated} />
        ) : null}
      </div>

      <ForumPostActions
        postId={post.postId}
        likedByMe={post.likedByMe}
        likeCount={post.likeCount}
        canEdit={post.canEdit}
        canDelete={post.canDelete}
        canModerate={post.canModerate}
        isPinned={post.isPinned}
        authenticated={authenticated}
        deleted={post.status === 'deleted'}
      />

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 17 }}>回复（{post.replyCount}）</h2>

        {!authenticated ? (
          <p className="muted" style={{ fontSize: 13 }}>
            <Link href={'/onboarding?returnTo=/forum/' + slug + '/' + postId}>登录后回复</Link>
          </p>
        ) : post.status === 'published' ? (
          <div style={{ marginBottom: 16 }}>
            <ForumReplyForm postId={post.postId} />
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            该帖已删除，不能再回复。
          </p>
        )}

        {replies.items.length === 0 ? (
          <p className="empty">还没有回复。</p>
        ) : (
          <ul className="item-list">
            {replies.items.map((reply) => (
              <li key={reply.replyId} className="item" style={{ display: 'block' }}>
                <div className="item-body">
                  <div className="list-meta">
                    <span>{reply.authorNickname}</span>
                    <span>{formatDateTimeOr(reply.createdAt, '未知')}</span>
                    {reply.status === 'deleted' ? <span>已删除</span> : null}
                  </div>
                  {reply.status === 'deleted' ? (
                    <p className="muted" style={{ margin: '6px 0' }}>
                      该回复已被删除。
                    </p>
                  ) : reply.bodyMd === null ? (
                    <p className="muted" style={{ margin: '6px 0' }}>
                      该回复已被删除。
                    </p>
                  ) : (
                    <div
                      className="markdown-body"
                      style={{ margin: '6px 0' }}
                      dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(reply.bodyMd) }}
                    />
                  )}

                  {reply.children.length > 0 ? (
                    <ul className="item-list" style={{ marginTop: 8, paddingLeft: 16 }}>
                      {reply.children.map((child) => (
                        <li key={child.replyId} className="item" style={{ display: 'block' }}>
                          <div className="item-body">
                            <div className="list-meta">
                              <span>{child.authorNickname}</span>
                              <span>{formatDateTimeOr(child.createdAt, '未知')}</span>
                            </div>
                            {child.status === 'deleted' ? (
                              <p className="muted" style={{ margin: '6px 0' }}>
                                该回复已被删除。
                              </p>
                            ) : child.bodyMd === null ? (
                              <p className="muted" style={{ margin: '6px 0' }}>
                                该回复已被删除。
                              </p>
                            ) : (
                              <div
                                className="markdown-body"
                                style={{ margin: '6px 0' }}
                                dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(child.bodyMd) }}
                              />
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {reply.status === 'published' && post.status === 'published' ? (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
                      <ReportButton targetKind="forum_reply" targetId={reply.replyId} authenticated={authenticated} />
                      {authenticated ? (
                        <ForumReplyForm postId={post.postId} parentId={reply.replyId} compact />
                      ) : null}
                    </div>
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
