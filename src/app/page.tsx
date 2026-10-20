/**
 * 首页：三块 —— 搜索入口、「最新评测」、「近期更新插件」。
 *
 * 视觉：英雄区大字展示标题 + 搜索，直接落在深色底上（不套面板）；
 * 下面双栏面板（最新评测约 2/3 + 近期更新插件约 1/3）。
 *
 * 三块都真实渲染：没数据就显示空状态，不塞样例数据。
 * 插件一块的排序口径必须与 /plugins 一致，否则首页与目录会各说各话。
 */

import Link from 'next/link';
import { HomeFeed } from '@/components/home-feed';
import { LoadMore } from '@/components/load-more';
import { getDb } from '@/server/platform/db';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { createCatalogService } from '@/server/modules/catalog';
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

function latestPublicReviews(limit: number): { rows: Row[]; total: number } {
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
  const visible = rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible);
  return { rows: visible.slice(0, limit), total: visible.length };
}

/** 评测对应的插件展示名：清单名优先（缺则仓库全名），子目录形态带上子路径；插件被删也不会崩（LEFT JOIN）。 */
function pluginLabel(row: Row): string | null {
  if (row.repo_full_name === null) return null;
  const base = row.plugin_display_name ?? row.repo_full_name;
  const subPath = row.plugin_path && row.plugin_path !== '.' ? ` / ${row.plugin_path}` : '';
  return `${base}${subPath}`;
}

/** 分类链接只带 cat 一个条件——首页不做组合筛选，进目录后再叠加。 */
function categoryHref(slug: string | null): string {
  if (slug === null) return '/plugins';
  return `/plugins?cat=${encodeURIComponent(slug)}`;
}

/** 手机端滚动加载的条数参数：只允许在默认值之上增加（防止 URL 把列表清空）。 */
function readCount(raw: string | string[] | undefined, fallback: number, max: number): number {
  const value = Number.parseInt((Array.isArray(raw) ? raw[0] : raw) ?? '', 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, fallback), max) : fallback;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // 桌面端用默认条数（24 / 12，两栏等高）；手机端滚动时由 LoadMore 递增 rv / pv。
  const reviewLimit = readCount(sp.rv, 24, 120);
  const pluginLimit = readCount(sp.pv, 12, 96);
  const { rows: reviews, total: reviewTotal } = latestPublicReviews(reviewLimit);
  const catalog = createCatalogService({ db: getDb() });
  const recentPlugins = await catalog.listPlugins({ page: 1, page_size: pluginLimit });
  // 页面 chip 行用**分类**（中文、按不同仓库计数），不再直接暴露原始 topics
  const categories = await catalog.listCategories();

  return (
    <div>
      {/* 英雄区：站名作为主标题，下面直接是搜索与分类 */}
      <section className="home-hero">
        <h1 className="home-title">DSH 插件评测</h1>

        {/* 搜索入口：GET 到目录页，条件留在 URL 里 */}
        <form action="/plugins" method="get" className="search home-search">
          <input
            type="search"
            name="q"
            placeholder="搜插件名、作者仓库或简介"
            aria-label="搜索插件"
          />
          {/* 搜索动作简化成一个放大镜图标按钮（主人要求）：与输入框同一行，不再换行占两行 */}
          <button type="submit" className="search-go" aria-label="搜索">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
          </button>
        </form>

        {/* 分类为空（还没收录）时整行不渲染 */}
        {categories.length > 0 ? (
          <div className="filters" role="navigation" aria-label="按用途分类浏览" style={{ marginBottom: 0 }}>
            {/* 「用途分类」标签按主人要求去掉：这一排本来就是分类 chip，标题是多余的 */}
            <Link href={categoryHref(null)} className="active">
              全部
            </Link>
            {categories.slice(0, 10).map((c) => (
              <Link key={c.slug} href={categoryHref(c.slug)}>
                {c.label} <span className="count">{c.repositoryCount}</span>
              </Link>
            ))}
            {/* 「更多插件 →」按主人要求去掉：分类 chip 本身已能进目录，多一个出口反而显乱 */}
          </div>
        ) : null}
      </section>

      {/* 双栏内容默认只占一屏，超出部分点「展开全部」（主人要求：一页长度 + 展开）。 */}
      <HomeFeed>
        {/* 主栏：最新评测 */}
        <section className="panel" aria-labelledby="home-reviews">
          <div className="section-head">
            {/* 栏目头只留标题（「全部评测」按主人要求去掉） */}
            <h2 id="home-reviews">最新评测</h2>
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
                    {/* 两列：来源标签 +（标题 + 元信息），元信息与标题同列（与评测列表一致） */}
                    <div className="item-head">
                      <span className={r.source_kind === 'site' ? 'tag site' : 'tag'}>
                        {r.source_kind === 'site' ? '站点评测' : '社区评测'}
                      </span>
                      <div className="item-main">
                        <h3 className="item-title">
                          <Link href={`/reviews/${r.review_id}`} className="truncate" style={{ display: 'block' }}>
                            {r.title}
                          </Link>
                        </h3>
                        <div className="list-meta">
                          {pluginLabel(r) === null ? (
                            <span>插件信息不可用</span>
                          ) : (
                            <Link href={`/plugins/${r.plugin_id}`} className="truncate">
                              {pluginLabel(r)}
                            </Link>
                          )}
                          <span>{formatDateTimeOr(r.public_updated_at, '时间未知')}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {/* 手机端滚到这里时再向服务端要下一批（桌面端不渲染哨兵）。 */}
          <LoadMore param="rv" value={reviewLimit} step={12} total={reviewTotal} />
        </section>

        {/* 辅栏：近期更新插件 */}
        <aside className="panel" aria-labelledby="home-plugins">
          <div className="section-head">
            {/* 栏目头只留标题（「全部插件」按主人要求去掉） */}
            <h2 id="home-plugins">近期更新插件</h2>
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
                          <img src={p.ownerAvatarUrl} alt="" width={42} height={42} loading="lazy" decoding="async" />
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
                          {p.topics.length > 0 ? (
                            <span className="tag" style={{ marginRight: 0 }}>
                              {p.topics[0]}
                            </span>
                          ) : null}
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
          <LoadMore param="pv" value={pluginLimit} step={6} total={recentPlugins.total} />
        </aside>
      </HomeFeed>
    </div>
  );
}