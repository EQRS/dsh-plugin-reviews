/**
 * 首页（页面布局.md 第 3 节的三块：搜索入口、最新评测、近期更新插件）。
 *
 * 这里**不再**写"搜索、分类与筛选的完整交互见插件目录"这种空话 ——
 * 入口、评测、插件三块都真实渲染；没数据就显示空状态，不塞样例数据。
 *
 * 视觉重排（本轮）：
 *  - 搜索英雄区 + **用途分类 chips**（§3 首块明确要求"用途分类：全部 / 已启用分类……"，
 *    分类链接带 tag 进目录并保留语义，不是装饰）；
 *  - 桌面双栏：最新评测约 2/3、近期更新插件约 1/3（§3 线框图的比例）；手机单列。
 *
 * 文案纪律：验收脚本会断言"最新评测 / 近期更新插件 / 共 N 个条目"等真实字样，
 * 重排时**逐字保留**既有空状态与统计文案；数量口径不动（评测 6、插件 12）。
 *
 * 插件一块直接调 catalog 服务（而不是另写一段 SQL）：排序口径必须与 /plugins 一致，
 * 否则"首页说最近更新的是 A、目录说是 B"。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { createCatalogService } from '@/server/modules/catalog';
import { UNCLASSIFIED_TAG } from '@/server/modules/catalog/service';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

interface Row {
  review_id: string;
  title: string;
  plugin_id: string | null;
  public_updated_at: number | null;
  source_kind: 'community' | 'site';
  plugin_display_name: string | null;
  plugin_path: string | null;
  repo_full_name: string | null;
}

function latestPublicReviews(limit: number): Row[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, r.plugin_id, ce.public_updated_at, r.source_kind,
              p.display_name AS plugin_display_name, p.plugin_path, repo.full_name AS repo_full_name
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
         LEFT JOIN plugins p ON p.id = r.plugin_id
         LEFT JOIN repositories repo ON repo.id = p.repository_id
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all() as Row[];
  // 公开资格逐行核验，不另存公开状态字段。
  return rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible).slice(0, limit);
}

/** 评测对应的插件展示名：清单名优先（缺则仓库全名），子目录形态带上子路径；插件被删也不会崩（LEFT JOIN）。 */
function pluginLabel(row: Row): string | null {
  if (row.repo_full_name === null) return null;
  const base = row.plugin_display_name ?? row.repo_full_name;
  const subPath = row.plugin_path && row.plugin_path !== '.' ? ` / ${row.plugin_path}` : '';
  return `${base}${subPath}`;
}

/** 分类链接只带 tag 一个条件——首页不做组合筛选，进目录后再叠加。 */
function tagHref(tag: string | null): string {
  if (tag === null) return '/plugins';
  return `/plugins?tag=${encodeURIComponent(tag)}`;
}

export default async function HomePage() {
  const reviews = latestPublicReviews(6);
  const catalog = createCatalogService({ db: getDb() });
  const recentPlugins = await catalog.listPlugins({ page: 1, page_size: 12 });
  const tags = await catalog.listPluginTags();

  return (
    <div>
      {/* 英雄区：搜索 + 分类（§3 首块）。分类为空（还没收录）时整行不渲染，不给"全部 0"的假筛选。 */}
      <section className="panel" style={{ marginBottom: 'var(--space-6)' }}>
        <h1 style={{ marginBottom: 4 }}>找 DSH 插件</h1>
        <p className="muted">
          本站独立收录插件，<strong>收录 ≠ 已实测可用</strong>。评测由社区与站点分别撰写，公开前都经过人工审核。
        </p>

        {/* 搜索入口：GET 到目录页，条件留在 URL 里（目录页负责筛选与分页） */}
        <form action="/plugins" method="get" className="search">
          <input
            type="search"
            name="q"
            placeholder="搜插件名、作者仓库或简介"
            aria-label="搜索插件"
          />
          <button type="submit" className="button primary">
            搜索
          </button>
        </form>

        {tags.length > 0 ? (
          <div className="filters" role="navigation" aria-label="按用途分类浏览" style={{ margin: '4px 0 0' }}>
            <span className="group-label">用途分类：</span>
            <Link href={tagHref(null)} className="active">
              全部
            </Link>
            {tags.slice(0, 10).map((t) => (
              <Link key={t.tag} href={tagHref(t.tag)}>
                {t.tag === UNCLASSIFIED_TAG ? '未分类' : t.tag} <span className="count">{t.pluginCount}</span>
              </Link>
            ))}
            <Link href="/plugins" style={{ marginLeft: 'auto' }}>
              更多插件 →
            </Link>
          </div>
        ) : null}
      </section>

      <div className="twocol">
        {/* 主栏（约 2/3）：最新评测 */}
        <section className="panel" aria-labelledby="home-reviews">
          <div className="section-head">
            <h2 id="home-reviews">最新评测</h2>
            <Link href="/reviews">全部评测</Link>
          </div>
          {reviews.length === 0 ? (
            <p className="empty">
              暂无公开评测。可以先去 <Link href="/plugins">插件目录</Link> 收录一个插件再写。
            </p>
          ) : (
            <ul className="item-list">
              {reviews.map((r) => (
                <li key={r.review_id} className="item">
                  <div className="item-body">
                    <h3>
                      <Link href={`/reviews/${r.review_id}`} className="truncate" style={{ display: 'block' }}>
                        {r.title}
                      </Link>
                    </h3>
                    <div className="list-meta">
                      <span className={r.source_kind === 'site' ? 'tag site' : 'tag'} style={{ marginRight: 0 }}>
                        {r.source_kind === 'site' ? '站点评测' : '社区评测'}
                      </span>
                      {pluginLabel(r) === null ? (
                        <span>插件信息不可用</span>
                      ) : (
                        <Link href={`/plugins/${r.plugin_id}`} className="truncate" style={{ color: 'var(--muted)' }}>
                          {pluginLabel(r)}
                        </Link>
                      )}
                      <span>{formatDateTimeOr(r.public_updated_at, '时间未知')}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 辅栏（约 1/3）：近期更新插件 */}
        <aside className="panel" aria-labelledby="home-plugins">
          <div className="section-head">
            <h2 id="home-plugins">近期更新插件</h2>
            <Link href="/plugins">全部插件</Link>
          </div>
          {recentPlugins.items.length === 0 ? (
            <p className="empty">
              还没有收录任何插件。可以从 <Link href="/plugins/new">提交插件</Link> 开始。
            </p>
          ) : (
            <>
              <ul className="item-list">
                {recentPlugins.items.map((p) => {
                  const initial = (p.displayName ?? p.repositoryFullName).slice(0, 1).toUpperCase();
                  return (
                    <li key={p.pluginId} className="item">
                      <span className="icon">
                        {p.ownerAvatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.ownerAvatarUrl} alt="" width={42} height={42} />
                        ) : (
                          initial
                        )}
                      </span>
                      <div className="item-body">
                        <h3 className="truncate">{p.displayName ?? p.repositoryFullName}</h3>
                        <p className="clamp-2" style={{ color: 'var(--muted)', fontSize: 14 }}>
                          {p.description ?? '暂无简介'}
                        </p>
                        <div className="list-meta">
                          <span>{p.publicReviewCount > 0 ? `${p.publicReviewCount} 篇公开评测` : '暂无评测'}</span>
                          {p.topics.length > 0 ? <span className="tag" style={{ marginRight: 0 }}>{p.topics[0]}</span> : null}
                          <span>资料更新 {formatDateTimeOr(p.infoUpdatedAt ?? p.updatedAt, '未知')}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {recentPlugins.total > recentPlugins.items.length ? (
                <p className="muted" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
                  目录里共有 {recentPlugins.total} 个条目，<Link href="/plugins">查看全部</Link>。
                </p>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
