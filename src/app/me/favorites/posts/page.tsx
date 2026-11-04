/**
 * 我的收藏 · 帖子。
 *
 * 已删除的帖子仍然列出来（软删）：作者删帖后，收藏者必须看得到「该帖已被删除」的痕迹，
 * 而不是让它凭空消失 —— 这条口径在三类收藏里只有帖子会碰到（迁移 0039 的注释也写了）。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../../api/_lib/context';
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { MeNav } from '@/components/me-nav';
import { CreateFolderForm } from '@/components/create-folder-form';
import { FavoritesTabs } from '@/components/favorites-tabs';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function FavoritePostsPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/favorites/posts');

  const service = createInteractionsService({ db: getDb() });
  const posts = await service.listFavoritePosts(ctx);

  return (
    <div>
      <h1>我的收藏</h1>
      <div className="me-layout">
        <MeNav current="favorites" />
        <div>
          <FavoritesTabs current="post" />

          <section className="panel" aria-label="收藏的帖子">
            <div className="section-head">
              <h2>收藏的帖子（{posts.length}）</h2>
            </div>
            <CreateFolderForm kind="post" />
            {posts.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                还没有收藏帖子。去<Link href="/forum">讨论区</Link>看看。
              </p>
            ) : (
              <ul className="item-list">
                {posts.map((post) => (
                  <li key={post.postId} className="item">
                    <div className="item-body">
                      <h3>
                        {post.status === 'deleted' ? (
                          <span className="muted">{post.title}</span>
                        ) : (
                          <Link href={`/forum/${post.boardSlug}/${post.postId}`}>{post.title}</Link>
                        )}
                        <span className="tag site" style={{ marginLeft: 8 }}>
                          在「{post.folderName}」
                        </span>
                      </h3>
                      <div className="list-meta">
                        <span>{post.boardName}</span>
                        <span>作者 {post.authorNickname}</span>
                        {post.status === 'deleted' ? (
                          <span className="tag warn">已删除</span>
                        ) : (
                          <span>{post.replyCount} 回复</span>
                        )}
                        <span>收藏于 {formatDateTime(post.createdAt)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}