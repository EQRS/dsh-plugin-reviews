/**
 * 我的收藏（`idea.md §15`）：插件收藏在 P1 上线；整合包收藏等 P4。
 *
 * 服务端直接查库（不额外开接口）：这个页面只有本人能看，没必要为它多一层 API。
 * 未登录跳登录（`returnTo` 是 `/onboarding` 认的参数名）。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../api/_lib/context';
import { getDb } from '@/server/platform/db';
import { createInteractionsService } from '@/server/modules/interactions';
import { MeNav } from '@/components/me-nav';
import { formatDateTime } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function FavoritesPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/favorites');

  const favorites = await createInteractionsService({ db: getDb() }).listFavoritePlugins(ctx);

  return (
    <div>
      <h1>我的收藏</h1>
      <div className="me-layout">
        <MeNav current="favorites" />
        <div>
          <section className="panel" aria-label="收藏的插件">
            <div className="section-head">
              <h2>收藏的插件（{favorites.length}）</h2>
            </div>
            {favorites.length === 0 ? (
              <p className="muted">
                还没有收藏。去<Link href="/plugins">插件目录</Link>看看，插件详情页右上角可以收藏。
              </p>
            ) : (
              <ul className="list">
                {favorites.map((f) => (
                  <li key={f.pluginId} className="item">
                    <div>
                      <h3>
                        <Link href={`/plugins/${f.pluginId}`}>{f.displayName ?? f.repositoryFullName}</Link>
                        {f.pluginPath !== '.' ? <span className="muted"> · {f.pluginPath}</span> : null}
                      </h3>
                      <div className="list-meta">
                        <span>{f.repositoryFullName}</span>
                        <span>收藏于 {formatDateTime(f.createdAt)}</span>
                        {f.isArchived ? <span className="tag warn">已归档</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            整合包收藏会在整合包上线后出现在这里（当前 `plugin_packs` 尚未建立）。
          </p>
        </div>
      </div>
    </div>
  );
}
