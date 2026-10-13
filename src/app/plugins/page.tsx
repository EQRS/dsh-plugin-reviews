/**
 * 插件目录（页面布局.md 第 4 节 + idea.md 第 35-69 行）：搜索 / 筛选 / 排序 / 分页。
 *
 * 设计纪律：
 *  1. **条件全部保留在 URL**（刷新、分享、后退都还在），改条件时**回第一页**；
 *  2. 分页与筛选在服务端完成（真实总数），不用"前端拿全量再筛"——那样 total 是假的；
 *  3. 两种空状态**文案必须不同**：目录真的为空 vs 筛选没匹配到（后者要给"清除条件"）；
 *  4. 未登录也能看（公开读取）。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { UNCLASSIFIED_TAG } from '@/server/modules/catalog/service';
import { formatDateTimeOr } from '@/packages/common/time';
import type { PluginSummary } from '@/server/modules/catalog/types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 12;

interface DirectoryConditions {
  q?: string;
  tag?: string;
  hasReviews: 'all' | 'yes' | 'no';
  sort: 'info' | 'reviews';
  page: number;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** URL 条件 → 结构化条件（**所有非法值都退回默认**，不让 URL 把页面搞崩）。 */
function readConditions(sp: Record<string, string | string[] | undefined>): DirectoryConditions {
  const rawPage = Number.parseInt(firstValue(sp.page) ?? '1', 10);
  const hasReviewsRaw = firstValue(sp.has_reviews);
  return {
    // 关键词截断到 100 字：搜索框不是注入口
    q: firstValue(sp.q)?.trim().slice(0, 100) || undefined,
    tag: firstValue(sp.tag)?.slice(0, 64) || undefined,
    hasReviews: hasReviewsRaw === 'yes' || hasReviewsRaw === 'no' ? hasReviewsRaw : 'all',
    sort: firstValue(sp.sort) === 'reviews' ? 'reviews' : 'info',
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

/** 生成目录链接：只带上"非默认"的条件，并**永远丢掉 page**（改条件回第一页）。 */
function listHref(current: DirectoryConditions, over: Partial<DirectoryConditions> = {}): string {
  const merged = { ...current, page: undefined, ...over } as DirectoryConditions & { page?: number };
  const params = new URLSearchParams();
  if (merged.q) params.set('q', merged.q);
  if (merged.tag) params.set('tag', merged.tag);
  if (merged.hasReviews !== 'all') params.set('has_reviews', merged.hasReviews);
  if (merged.sort !== 'info') params.set('sort', merged.sort);
  if (over.page !== undefined && over.page > 1) params.set('page', String(over.page));
  const qs = params.toString();
  return qs.length > 0 ? `/plugins?${qs}` : '/plugins';
}

function hasAnyFilter(c: DirectoryConditions): boolean {
  return Boolean(c.q) || Boolean(c.tag) || c.hasReviews !== 'all';
}

/** 卡片上的一行小标签（用途标签 / 状态）。 */
function Chip({ text, tone = 'plain' }: { text: string; tone?: 'plain' | 'tag' | 'warn' }) {
  const palette =
    tone === 'tag'
      ? { background: '#EEF3FF', color: '#2456B8' }
      : tone === 'warn'
        ? { background: '#FFF9E8', color: '#8A6D1C' }
        : { background: '#F3F5F8', color: '#526174' };
  return (
    <span style={{ ...palette, borderRadius: 4, padding: '1px 6px', fontSize: 12, marginRight: 6 }}>{text}</span>
  );
}

function PluginCard({ plugin }: { plugin: PluginSummary }) {
  const label = `${plugin.repositoryFullName}${plugin.pluginPath === '.' ? '' : ` / ${plugin.pluginPath}`}`;
  const title = plugin.displayName ?? label;
  const initial = (plugin.displayName ?? plugin.repositoryFullName).slice(0, 1).toUpperCase();

  return (
    <li
      style={{
        background: '#FFFFFF',
        border: '1px solid #DBE1EA',
        borderRadius: 10,
        padding: 12,
        marginBottom: 8,
        display: 'flex',
        gap: 12,
      }}
    >
      {/* 图标：有 owner 头像就用（外链，不代理），否则用首字母方块兜底 */}
      {plugin.ownerAvatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={plugin.ownerAvatarUrl} alt="" width={40} height={40} style={{ borderRadius: 8, flex: '0 0 auto' }} />
      ) : (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: '#F3F5F8',
            color: '#526174',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
            fontWeight: 600,
          }}
        >
          {initial}
        </div>
      )}

      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div>
          <Link href={`/plugins/${plugin.pluginId}`} style={{ color: '#2456B8', fontWeight: 600 }}>
            {title}
          </Link>
          {plugin.displayName ? (
            <span style={{ color: '#8A94A6', fontSize: 13 }}> · {label}</span>
          ) : null}
        </div>

        <div style={{ color: '#526174', fontSize: 14, marginTop: 2 }}>
          {/* 简介：没有就明说"暂无简介"，不留空行让人以为加载失败 */}
          {plugin.description ?? '暂无简介'}
        </div>

        <div style={{ marginTop: 6 }}>
          {plugin.topics.length === 0 ? <Chip text="未分类" /> : plugin.topics.slice(0, 6).map((t) => <Chip key={t} text={t} tone="tag" />)}
          {plugin.publicReviewCount > 0 ? (
            <Chip text={`${plugin.publicReviewCount} 篇公开评测`} />
          ) : (
            <Chip text="暂无评测" />
          )}
          {plugin.isArchived ? <Chip text="已归档" tone="warn" /> : null}
          {plugin.availabilityState !== 'available' ? <Chip text="仓库暂不可访问" tone="warn" /> : null}
        </div>

        <div style={{ color: '#8A94A6', fontSize: 12, marginTop: 6 }}>
          作者 {plugin.authorLogin ?? plugin.ownerLogin ?? '未知'} ·
          资料更新 {formatDateTimeOr(plugin.infoUpdatedAt ?? plugin.updatedAt, '未知')} ·
          仓库更新 {formatDateTimeOr(plugin.repoUpdatedAt, '未知')}
        </div>
      </div>
    </li>
  );
}

export default async function PluginsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const conditions = readConditions(await searchParams);
  const catalog = createCatalogService({ db: getDb() });

  const result = await catalog.listPlugins({
    page: conditions.page,
    page_size: PAGE_SIZE,
    q: conditions.q,
    tag: conditions.tag,
    hasReviews: conditions.hasReviews,
    sort: conditions.sort,
  });
  const tags = await catalog.listPluginTags();

  // 空结果时再问一次"不带条件时有多少" —— 这样能把"目录为空"与"筛选没匹配到"分开，
  // 而不是一律显示"暂无插件"（那会让用户以为站点是空的）。
  const totalWithoutFilter =
    result.total === 0 ? (await catalog.listPlugins({ page: 1, page_size: 1 })).total : result.total;

  // 越界页（把 page=99 手打进 URL）：单独给"超出范围 + 回第 1 页"，**不要**再报"没有符合条件的条目"
  // —— 那样会让用户以为筛选条件把条目滤光了，于是反复改条件。
  const outOfRange = result.items.length === 0 && result.total > 0 && conditions.page > 1;

  const emptyKind: 'none' | 'directory-empty' | 'filtered-empty' =
    result.items.length > 0 || outOfRange
      ? 'none'
      : totalWithoutFilter === 0
        ? 'directory-empty'
        : 'filtered-empty';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>插件目录</h1>
        <Link
          href="/plugins/new"
          style={{
            background: '#2456B8',
            color: '#FFFFFF',
            borderRadius: 8,
            padding: '8px 14px',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          提交插件
        </Link>
      </div>

      <p style={{ color: '#526174' }}>
        共 {result.total} 个条目
        {hasAnyFilter(conditions) ? `（已筛选，全部条目 ${totalWithoutFilter} 个）` : ''}
        {result.total_pages > 1 ? ` · 第 ${result.page} / ${result.total_pages} 页` : ''}
        。收录 ≠ 已实测可用。
      </p>

      {/* 搜索：GET 表单，条件留在 URL 里；筛选与排序用链接，避免 JS */}
      <form action="/plugins" method="get" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="search"
          name="q"
          defaultValue={conditions.q ?? ''}
          placeholder="搜插件名、作者仓库或简介"
          aria-label="搜索插件"
          style={{ flex: '1 1 auto', padding: '8px 10px', border: '1px solid #DBE1EA', borderRadius: 8 }}
        />
        {conditions.tag ? <input type="hidden" name="tag" value={conditions.tag} /> : null}
        {conditions.hasReviews !== 'all' ? (
          <input type="hidden" name="has_reviews" value={conditions.hasReviews} />
        ) : null}
        {conditions.sort !== 'info' ? <input type="hidden" name="sort" value={conditions.sort} /> : null}
        <button type="submit" style={{ background: '#2456B8', color: '#FFFFFF', border: 'none', borderRadius: 8, padding: '8px 16px' }}>
          搜索
        </button>
        {hasAnyFilter(conditions) || conditions.q ? (
          <Link
            href="/plugins"
            style={{ alignSelf: 'center', color: '#526174', fontSize: 14, whiteSpace: 'nowrap' }}
          >
            清除条件
          </Link>
        ) : null}
      </form>

      {/* 用途标签（来自 GitHub topics；本切片还没有中文分类字典，故无标签即"未分类"） */}
      {tags.length > 0 ? (
        <div style={{ marginBottom: 8 }}>
          <Link href={listHref(conditions, { tag: undefined })} style={{ marginRight: 8, color: conditions.tag ? '#2456B8' : '#111827', fontWeight: conditions.tag ? 400 : 600 }}>
            全部
          </Link>
          {tags.slice(0, 15).map((t) => (
            <Link
              key={t.tag}
              href={listHref(conditions, { tag: t.tag })}
              style={{
                marginRight: 8,
                color: conditions.tag === t.tag ? '#111827' : '#2456B8',
                fontWeight: conditions.tag === t.tag ? 600 : 400,
              }}
            >
              {t.tag === UNCLASSIFIED_TAG ? '未分类' : t.tag}
              <span style={{ color: '#8A94A6', fontSize: 12 }}> {t.pluginCount}</span>
            </Link>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, fontSize: 14 }}>
        <span>
          {(['all', 'yes', 'no'] as const).map((v) => (
            <Link
              key={v}
              href={listHref(conditions, { hasReviews: v })}
              style={{
                marginRight: 8,
                color: conditions.hasReviews === v ? '#111827' : '#2456B8',
                fontWeight: conditions.hasReviews === v ? 600 : 400,
              }}
            >
              {v === 'all' ? '全部' : v === 'yes' ? '已有评测' : '暂无评测'}
            </Link>
          ))}
        </span>
        <span style={{ color: '#DBE1EA' }}>|</span>
        <span>
          {(['info', 'reviews'] as const).map((v) => (
            <Link
              key={v}
              href={listHref(conditions, { sort: v })}
              style={{
                marginRight: 8,
                color: conditions.sort === v ? '#111827' : '#2456B8',
                fontWeight: conditions.sort === v ? 600 : 400,
              }}
            >
              {v === 'info' ? '按资料更新时间' : '按评测数'}
            </Link>
          ))}
        </span>
      </div>

      {outOfRange ? (
        <p style={{ color: '#8A6D1C' }}>
          第 {conditions.page} 页超出范围（共 {result.total_pages} 页）。<Link href={listHref(conditions, { page: 1 })}>回到第 1 页</Link>。
        </p>
      ) : null}

      {emptyKind === 'directory-empty' ? (
        <p style={{ color: '#526174' }}>
          目录当前为空，还没有任何插件被收录。可以从 <Link href="/plugins/new">提交插件</Link> 开始。
        </p>
      ) : null}

      {emptyKind === 'filtered-empty' ? (
        <p style={{ color: '#526174' }}>
          没有符合当前条件的条目（目录里共有 {totalWithoutFilter} 个）。
          <Link href="/plugins">清除全部条件</Link>。
        </p>
      ) : null}

      {result.items.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {result.items.map((p) => (
            <PluginCard key={p.pluginId} plugin={p} />
          ))}
        </ul>
      ) : null}

      {result.total_pages > 1 ? (
        <div style={{ marginTop: 12, fontSize: 14 }}>
          {conditions.page > 1 ? <Link href={listHref(conditions, { page: conditions.page - 1 })}>← 上一页</Link> : null}
          <span style={{ color: '#8A94A6', margin: '0 10px' }}>
            {conditions.page} / {result.total_pages}
          </span>
          {conditions.page < result.total_pages ? (
            <Link href={listHref(conditions, { page: conditions.page + 1 })}>下一页 →</Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
