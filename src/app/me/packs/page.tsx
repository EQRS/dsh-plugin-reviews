/**
 * 我的整合包（`idea.md` §26 个人中心）：按包展示 + 最近公开版本状态 + 新建入口。
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { isAuthenticated } from '@/server/platform/context';
import { createPacksService } from '@/server/modules/packs';
import { currentContext } from '../../api/_lib/context';
import { MeNav } from '@/components/me-nav';
import { formatDateTimeOr } from '@/packages/common/time';
import { PackReleaseActions } from '@/components/pack-release-actions';

export const dynamic = 'force-dynamic';

export default async function MyPacksPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/packs');

  const packs = await createPacksService({ db: getDb() }).listMyPacks(ctx);

  return (
    <div>
      <h1>我的整合包</h1>
      <div className="me-layout">
        <MeNav current="packs" />
        <div>
          <section className="panel" aria-label="我创建的整合包">
            <div className="section-head">
              <h2>我创建的（{packs.length}）</h2>
              <Link href="/me/packs/new" className="button">
                新建整合包
              </Link>
            </div>

            {packs.length === 0 ? (
              <p className="empty" style={{ marginBottom: 0 }}>
                还没有整合包。可以从收藏夹一键创建一个组合，并给每个插件标上版本与安装目标。
              </p>
            ) : (
              <ul className="item-list">
                {packs.map((pack) => (
                  <li key={pack.packId} className="item">
                    <div className="item-body">
                      <div className="item-head">
                        <span
                          className={
                            pack.reviewStatus === 'published' && !pack.withdrawn
                              ? 'tag site'
                              : 'tag warn'
                          }
                        >
                          {pack.reviewStatus === 'draft'
                            ? '未提交'
                            : pack.reviewStatus === 'pending'
                              ? '待审核'
                              : pack.reviewStatus === 'rejected'
                                ? '已拒绝'
                                : pack.withdrawn
                                  ? '已撤回'
                                  : '已发布'}
                        </span>
                        <div className="item-main">
                          <h3 className="item-title">
                            <Link href={`/packs/${pack.packId}`}>{pack.title}</Link>
                          </h3>
                          <div className="list-meta">
                            <span className="truncate">{pack.purpose}</span>
                            <span>{pack.pluginCount} 个插件</span>
                            <span>{pack.favoriteCount} 收藏</span>
                            <span>{formatDateTimeOr(pack.publishedAt, '时间未知')}</span>
                            {pack.reviewNote ? <span className="muted">审核意见：{pack.reviewNote}</span> : null}
                            <span style={{ marginLeft: 'auto' }}>
                              <PackReleaseActions
                                releaseId={pack.releaseId}
                                packId={pack.packId}
                                reviewStatus={pack.reviewStatus ?? 'draft'}
                                withdrawn={pack.withdrawn ?? false}
                              />
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            版本一旦发布即冻结：修正内容需要发布新版本，旧版本保持可查。
          </p>
        </div>
      </div>
    </div>
  );
}
