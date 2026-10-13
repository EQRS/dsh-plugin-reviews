/**
 * 插件详情（页面布局.md 第 5 节）：插件介绍与本站评测同页可达。
 *
 * 最小切片只展示已同步的结构化资料与本站评测入口；
 * README 抓取、安装资料核验属本切片范围外。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { resolveVisibilityInTx } from '@/server/modules/content';
import { currentContext } from '@/app/api/_lib/context';
import { StartDraftButton } from '@/components/start-draft-button';
import { formatDateTimeOr } from '@/packages/common/time';

export const dynamic = 'force-dynamic';

export default async function PluginDetailPage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  const db = getDb();
  const catalog = createCatalogService({ db });
  const plugin = await catalog.getPlugin(pluginId);
  if (!plugin) notFound();

  const ctx = await currentContext();

  // 本插件下的公开评测
  const rows = db
    .prepare(
      `SELECT r.id AS review_id, rev.title, ce.public_updated_at
         FROM reviews r
         JOIN content_entities ce ON ce.id = r.id
         JOIN review_revisions rev ON rev.id = r.published_revision_id
        WHERE r.plugin_id = ?
        ORDER BY ce.public_updated_at DESC, r.id ASC`,
    )
    .all(pluginId) as { review_id: string; title: string; public_updated_at: number | null }[];
  const reviews = rows.filter((row) => resolveVisibilityInTx(db, row.review_id).publiclyVisible);

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>
        {plugin.displayName ?? plugin.repository.fullName}
        {plugin.pluginPath === '.' ? '' : ` / ${plugin.pluginPath}`}
      </h1>
      {plugin.displayName ? (
        <p style={{ color: '#8A94A6', fontSize: 13, marginTop: -8 }}>
          {plugin.repository.fullName}
          {plugin.pluginPath === '.' ? '' : ` / ${plugin.pluginPath}`}
        </p>
      ) : null}

      {/* 简介：没有就明说"暂无简介"，不留空行（本地旧条目正是这种情形） */}
      <p style={{ color: '#111827' }}>{plugin.description ?? '暂无简介'}</p>

      <p>
        {/* 用途标签来自 GitHub topics；本切片还没有中文分类字典，无标签即"未分类" */}
        {(plugin.topics.length > 0 ? plugin.topics : ['未分类']).map((t) => (
          <span
            key={t}
            style={{ background: '#EEF3FF', color: '#2456B8', borderRadius: 4, padding: '2px 8px', fontSize: 13, marginRight: 6 }}
          >
            {t}
          </span>
        ))}
        {plugin.repository.isArchived ? (
          <span style={{ background: '#FFF9E8', color: '#8A6D1C', borderRadius: 4, padding: '2px 8px', fontSize: 13 }}>
            已归档
          </span>
        ) : null}
      </p>

      <p style={{ color: '#526174' }}>
        仓库：{' '}
        <a href={plugin.repository.htmlUrl} style={{ color: '#2456B8' }}>
          {plugin.repository.htmlUrl}
        </a>
        <br />
        作者：{plugin.authorLogin ?? plugin.ownerLogin ?? '未知'}
        {plugin.manifestVersion ? ` · 清单版本 ${plugin.manifestVersion}` : ''}
        <br />
        上游状态：{plugin.repository.availabilityState}
        {plugin.repository.isArchived ? ' · 已归档' : ''}
        {plugin.repository.availabilityState !== 'available' ? '（以下为最后一次成功同步的资料）' : ''}
        <br />
        子路径：<code>{plugin.pluginPath}</code>
        <br />
        {/* 两个时间语义不同，必须分开写：前者是"本站何时拉的"，后者是"上游仓库何时动的" */}
        资料同步：{formatDateTimeOr(plugin.infoUpdatedAt ?? plugin.updatedAt, '未知')} · 仓库更新：
        {formatDateTimeOr(plugin.repoUpdatedAt, '未知')}
      </p>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 20 }}>本站评测</h2>

        {/*
          设计口径（页面布局.md 第 5 节、实施顺序与验收.md 创作行）是"**从插件页写评测**"。
          这里必须带上 pluginId：评测在提交时会校验 plugin_id，而 review_revisions.plugin_id
          是 NOT NULL —— 不带插件的草稿永远提交不出去（点完才发现，是死路）。
        */}
        {ctx.userId === null ? (
          <p style={{ color: '#526174' }}>登录后可以在这里写评测（开发环境可用页面顶部的「测试登录」）。</p>
        ) : (
          <StartDraftButton pluginId={plugin.pluginId} />
        )}

        {reviews.length === 0 ? (
          <p style={{ color: '#526174' }}>暂无评测。</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {reviews.map((r) => (
              <li key={r.review_id} style={{ marginBottom: 6 }}>
                <Link href={`/reviews/${r.review_id}`} style={{ color: '#2456B8' }}>
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={{ marginTop: 24 }}>
        <Link href="/plugins" style={{ color: '#526174' }}>
          ← 返回插件目录
        </Link>
      </p>
    </div>
  );
}
