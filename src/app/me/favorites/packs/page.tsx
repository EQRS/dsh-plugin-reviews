/**
 * 我的收藏 · 整合包。
 *
 * 与插件子页的区别：这里**不分夹**地列出全部整合包收藏（跨夹聚合，带所在夹名），
 * 因为整合包收藏的量级远小于插件，分夹页面的收益抵不上多一次点击。
 * 夹本身仍存在、也能命名，只是不在这里逐夹展开。
 *
 * 全部版本都被撤回/隐藏的包仍然列出来（收藏者要看到痕迹），只是标题点不进去。
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

export default async function FavoritePacksPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/favorites/packs');

  const service = createInteractionsService({ db: getDb() });
  const packs = await service.listFavoritePacks(ctx);

  return (
    <div>
      <h1>我的收藏</h1>
      <div className="me-layout">
        <MeNav current="favorites" />
        <div>
          <FavoritesTabs current="pack" />

          <section className="panel" aria-label="收藏的整合包">
            <div className="section-head">
              <h2>收藏的整合包（{packs.length}）</h2>
            </div>
            <CreateFolderForm kind="pack" />
            {packs.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                还没有收藏整合包。去<Link href="/packs">整合包广场</Link>看看。
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
                        <span className="tag site" style={{ marginLeft: 8 }}>
                          在「{pack.folderName}」
                        </span>
                      </h3>
                      <div className="list-meta">
                        <span>作者 {pack.authorNickname}</span>
                        {pack.hasPublicRelease ? (
                          <span>{pack.pluginCount} 个插件</span>
                        ) : (
                          <span className="tag warn">{pack.hidden ? '已被隐藏' : '暂无可公开版本'}</span>
                        )}
                        {pack.releaseNumber !== null ? <span>第 {pack.releaseNumber} 版</span> : null}
                        <span>收藏于 {formatDateTime(pack.createdAt)}</span>
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