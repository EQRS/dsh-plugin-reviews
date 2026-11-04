/**
 * 单个收藏夹：按夹自身的类型渲染内容。
 *
 * 按需求，这里**不提供**新建收藏夹（收藏夹里不能叠加创建收藏夹）；
 * 新建入口在 /me/favorites/{plugins,packs,posts} 顶层。
 *
 * 0039 之后夹有三种类型，服务层的 getFavoriteFolder 一次性给回 { folder, plugins, packs, posts }，
 * 这里只取与 folder.targetKind 对应的那一份 —— 否则整合包夹 / 帖子夹点进去会是空列表。
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../../api/_lib/context';
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { MeNav } from '@/components/me-nav';
import { FolderPluginList } from '@/components/folder-plugin-list';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

const KIND_HOME: Record<string, string> = {
  plugin: '/me/favorites/plugins',
  pack: '/me/favorites/packs',
  post: '/me/favorites/posts',
};

export default async function FavoriteFolderPage({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) {
  const { folderId } = await params;
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect(`/onboarding?returnTo=/me/favorites/${folderId}`);

  const service = createInteractionsService({ db: getDb() });
  let data;
  try {
    data = await service.getFavoriteFolder(ctx, folderId);
  } catch {
    notFound();
  }

  const { folder, plugins, packs, posts } = data;
  const home = KIND_HOME[folder.targetKind] ?? '/me/favorites/plugins';
  const total =
    folder.targetKind === 'plugin' ? plugins.length : folder.targetKind === 'pack' ? packs.length : posts.length;

  return (
    <div>
      <h1>{folder.name}</h1>
      <div className="me-layout">
        <MeNav current="favorites" />
        <div>
          <p style={{ marginTop: 0 }}>
            <Link href={home}>← 返回收藏夹列表</Link>
          </p>

          <section className="panel" aria-label="收藏夹内容">
            <div className="section-head">
              <h2>
                {folder.name}（{total}）
                {folder.isDefault ? (
                  <span className="tag" style={{ marginLeft: 8 }}>
                    默认
                  </span>
                ) : null}
              </h2>
            </div>

            {folder.targetKind === 'plugin' ? (
              plugins.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  这个收藏夹还是空的。去<Link href="/plugins">插件目录</Link>看看，在插件详情页点「☆ 收藏」。
                </p>
              ) : (
                <FolderPluginList
                  plugins={plugins}
                  folders={(
                    await service.listFavoriteFolders(ctx, 'plugin')
                  ).map((f) => ({ folderId: f.folderId, name: f.name }))}
                  currentFolderId={folder.folderId}
                />
              )
            ) : null}

            {folder.targetKind === 'pack' ? (
              packs.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  这个收藏夹还是空的。去<Link href="/packs">整合包广场</Link>看看。
                </p>
              ) : (
                <ul className="item-list">
                  {packs.map((pack) => (
                    <li key={pack.packId} className="item">
                      <div className="item-body">
                        <h3>
                          {pack.hasPublicRelease ? (
                            <Link href={`/packs/${pack.packId}`}>{pack.title}</Link>
                          ) : (
                            <span className="muted">{pack.title}</span>
                          )}
                          {pack.hidden ? (
                            <span className="tag warn" style={{ marginLeft: 8 }}>
                              已被隐藏
                            </span>
                          ) : pack.withdrawn ? (
                            <span className="tag warn" style={{ marginLeft: 8 }}>
                              已撤回
                            </span>
                          ) : null}
                        </h3>
                        <div className="list-meta">
                          <span>作者 {pack.authorNickname}</span>
                          <span>{pack.pluginCount} 个插件</span>
                          <span>收藏于 {formatDateTime(pack.createdAt)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {folder.targetKind === 'post' ? (
              posts.length === 0 ? (
                <p className="empty" style={{ marginBottom: 0 }}>
                  这个收藏夹还是空的。去<Link href="/forum">讨论区</Link>看看。
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
                          {post.status === 'deleted' ? (
                            <span className="tag warn" style={{ marginLeft: 8 }}>
                              已删除
                            </span>
                          ) : null}
                        </h3>
                        <div className="list-meta">
                          <span>{post.boardName}</span>
                          <span>作者 {post.authorNickname}</span>
                          <span>{post.replyCount} 回复</span>
                          <span>收藏于 {formatDateTime(post.createdAt)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
