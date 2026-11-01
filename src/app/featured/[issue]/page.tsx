/**
 * 单期精选（公开）。
 *
 * 版式：期号 + 标题 + 主题 + 时间 → 前言（Markdown）→ 插件清单。
 * 清单每项固定为「图标 + 插件名：简述 / 推荐理由 / 评分」，链接按站内/站外分别处理。
 */

import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { createFeaturedService } from '@/server/modules/featured';
import type { FeaturedItemView } from '@/server/modules/featured';
import { renderMarkdownToSafeHtml } from '@/server/platform/markdown';
import { DomainError, ErrorCodes } from '@/packages/common/errors';
import { formatDateTimeOr } from '@/packages/common/time';
import { currentContext } from '@/app/api/_lib/context';
import { BackLink } from '@/components/back-link';

export const dynamic = 'force-dynamic';

/** 站内链接判断：相对路径直接算站内；绝对地址比对当前 host。 */
function classifyDetailLink(url: string, stationHost: string | null): 'internal' | 'external' {
  if (url.startsWith('/')) return 'internal';
  try {
    const parsed = new URL(url);
    if (stationHost && parsed.host.toLowerCase() === stationHost.toLowerCase()) return 'internal';
  } catch {
    /* 非法 URL 交给下面按外链处理 */
  }
  return 'external';
}

function PluginIcon({ item }: { item: FeaturedItemView }) {
  const label = item.plugin.displayName ?? item.plugin.repositoryFullName;
  return (
    <span className="icon" aria-hidden="true">
      {item.plugin.ownerAvatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.plugin.ownerAvatarUrl} alt="" width={42} height={42} loading="lazy" decoding="async" />
      ) : (
        <span className="icon-fallback">{label.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

function StatusTags({ item }: { item: FeaturedItemView }) {
  return (
    <>
      {item.plugin.isArchived ? <span className="tag warn">已归档</span> : null}
      {item.plugin.availabilityState !== 'available' ? <span className="tag warn">暂不可访问</span> : null}
      {item.recommendedVersion ? <span className="tag">推荐版本 {item.recommendedVersion}</span> : null}
    </>
  );
}

export default async function FeaturedIssuePage({ params }: { params: Promise<{ issue: string }> }) {
  const { issue } = await params;
  const issueNumber = Number.parseInt(issue, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) notFound();

  const ctx = await currentContext();
  const service = createFeaturedService({ db: getDb() });
  let detail;
  try {
    detail = await service.getPublished(ctx, issueNumber);
  } catch (e) {
    if (e instanceof DomainError && e.code === ErrorCodes.TARGET_UNAVAILABLE) notFound();
    throw e;
  }

  const headerBag = await headers();
  const stationHost = headerBag.get('host');
  const prefaceHtml = detail.prefaceMarkdown.trim() === '' ? '' : renderMarkdownToSafeHtml(detail.prefaceMarkdown);

  return (
    <div>
      <BackLink href="/featured">返回精选</BackLink>

      <header className="article-head" style={{ marginTop: 12 }}>
        <div className="article-meta">
          <span className="tag site">第 {detail.issueNumber} 期</span>
          {detail.status === 'draft' ? <span className="tag warn">草稿（仅管理员可见）</span> : null}
          <span>发布于 {formatDateTimeOr(detail.publishedAt, '未发布')}</span>
        </div>
        <h1 className="article-title">{detail.title}</h1>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          {detail.theme}
        </p>
      </header>

      {prefaceHtml ? (
        <section className="panel" style={{ marginTop: 16 }} aria-label="本期前言">
          <div className="review-body" dangerouslySetInnerHTML={{ __html: prefaceHtml }} />
        </section>
      ) : null}

      <section className="panel" style={{ marginTop: 16 }} aria-label="本期精选插件">
        <div className="section-head">
          <h2>本期插件（{detail.items.length}）</h2>
        </div>
        {detail.items.length === 0 ? (
          <p className="empty" style={{ marginBottom: 0 }}>
            这一期还没有插件。
          </p>
        ) : (
          <ol className="featured-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {detail.items.map((item) => {
              const label = item.plugin.displayName ?? item.plugin.repositoryFullName;
              const subPath = item.plugin.pluginPath && item.plugin.pluginPath !== '.' ? ' / ' + item.plugin.pluginPath : '';
              const href = item.detailUrl;
              const kind = href ? classifyDetailLink(href, stationHost) : null;
              return (
                <li
                  key={item.itemId}
                  className="featured-item"
                  style={{ display: 'flex', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--line)' }}
                >
                  <PluginIcon item={item} />
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <Link href={'/plugins/' + item.pluginId} style={{ fontWeight: 700 }}>
                        {label}
                      </Link>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {item.plugin.repositoryFullName}
                        {subPath}
                      </span>
                      <StatusTags item={item} />
                    </div>

                    <p style={{ margin: '6px 0 0' }}>{item.summary}</p>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      推荐理由：{item.reason}
                    </p>

                    <div className="list-meta" style={{ marginTop: 6 }}>
                      <span>
                        评分 <strong>{item.score}</strong>/100
                      </span>
                      <span className="muted">编辑评分</span>
                      {href && kind === 'internal' ? <Link href={href}>查看详细内容（官方测试集）</Link> : null}
                      {href && kind === 'external' ? (
                        <a href={href} target="_blank" rel="nofollow noreferrer noopener">
                          查看详细内容（官方测试集，外部链接） ↗
                        </a>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          评分为编辑依据插件功能性给出的主观判断，不代表官方认证。
        </p>
      </section>
    </div>
  );
}
