/**
 * 分区内帖子列表：默认按发布时间倒序，可切「最后回复」；置顶永远在前。
 *
 * 条件留在 URL（可分享、可返回），与评测列表同一口径。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { currentContext } from '@/app/api/_lib/context';
import { booleanSetting } from '@/server/modules/settings';
import { createForumBoardService } from '@/server/modules/forum/boards';
import { createForumPostService } from '@/server/modules/forum/posts';
import { POST_SORT_LABELS, type PostSortOption } from '@/packages/common/forum';
import { formatDateTimeOr } from '@/packages/common/time';
import { DomainError, ErrorCodes } from '@/packages/common/errors';

export const dynamic = 'force-dynamic';

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ForumBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  if (!booleanSetting(db, 'forum.enabled', true)) notFound();

  const { slug } = await params;
  const sp = await searchParams;
  const rawSort = firstValue(sp.sort);
  const sort: PostSortOption = rawSort === 'last_reply' ? 'last_reply' : 'created';
  const rawPage = Number.parseInt(firstValue(sp.page) ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const ctx = await currentContext();
  const boards = createForumBoardService({ db });
  const posts = createForumPostService({ db });

  let board;
  try {
    board = await boards.getBoard(ctx, slug);
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw e;
  }

  const list = await posts.listPosts(ctx, slug, { page, sort });
  const access = await boards.canPostIn(ctx, board.boardId);

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link href="/forum">← 返回讨论区</Link>
      </p>

      <div className="section-head">
        <h1 style={{ margin: 0 }}>{board.name}</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {board.canPost ? (
            <Link href={'/forum/new?board=' + board.slug} className="button">
              发帖
            </Link>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>
              {ctx.userId === null ? (
                <Link href={'/onboarding?returnTo=/forum/' + board.slug}>登录后发帖</Link>
              ) : (
                access.reason
              )}
            </span>
          )}
        </div>
      </div>

      {board.description ? (
        <p className="muted" style={{ marginTop: 0 }}>
          {board.description}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['created', 'last_reply'] as PostSortOption[]).map((key) => (
          <Link
            key={key}
            href={'/forum/' + board.slug + (key === 'created' ? '' : '?sort=' + key)}
            className={sort === key ? 'tag site' : 'tag'}
          >
            {POST_SORT_LABELS[key]}
          </Link>
        ))}
      </div>

      {list.items.length === 0 ? (
        <p className="empty">这个分区还没有帖子。</p>
      ) : (
        <ul className="item-list">
          {list.items.map((post) => (
            <li key={post.postId} className="item">
              <div className="item-body">
                <h3 className="item-title">
                  <Link href={'/forum/' + board.slug + '/' + post.postId}>
                    {post.isPinned ? '📌 ' : ''}
                    {post.title}
                  </Link>
                </h3>
                <div className="list-meta">
                  <span>{post.authorNickname}</span>
                  <span>{formatDateTimeOr(post.createdAt, '未知')}</span>
                  <span>{post.replyCount} 条回复</span>
                  <span>{post.likeCount} 赞</span>
                  {post.lastReplyAt !== null ? (
                    <span>最后回复 {formatDateTimeOr(post.lastReplyAt, '未知')}</span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {list.total_pages > 1 ? (
        <div className="pagination" style={{ marginTop: 16 }}>
          {page > 1 ? (
            <Link
              href={
                '/forum/' + board.slug + '?page=' + (page - 1) + (sort === 'created' ? '' : '&sort=' + sort)
              }
            >
              上一页
            </Link>
          ) : null}
          <span className="muted">
            第 {page} / {Math.max(1, list.total_pages)} 页
          </span>
          {page * list.page_size < list.total ? (
            <Link
              href={
                '/forum/' + board.slug + '?page=' + (page + 1) + (sort === 'created' ? '' : '&sort=' + sort)
              }
            >
              下一页
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
