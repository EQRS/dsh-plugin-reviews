/**
 * 插件目录（页面布局.md 第 4 节）：真实读取本站已收录插件；空库显示空状态。
 */

import Link from 'next/link';
import { getDb } from '@/server/platform/db';
import { createCatalogService } from '@/server/modules/catalog';
import { PaginationDefaults } from '@/packages/common/result';

export const dynamic = 'force-dynamic';

export default async function PluginsPage() {
  const catalog = createCatalogService({ db: getDb() });
  const page = await catalog.listPlugins({ page: 1, page_size: PaginationDefaults.default_page_size });

  return (
    <div>
      <h1 style={{ fontSize: 24 }}>插件目录</h1>
      <p style={{ color: '#526174' }}>
        共 {page.total} 个条目（第 {page.page} / {page.total_pages === 0 ? 0 : page.total_pages} 页）
      </p>

      {page.items.length === 0 ? (
        <p style={{ color: '#526174' }}>
          目录当前为空。收录入口见 <Link href="/me">我的</Link>（最小切片只在开发环境提供）。
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {page.items.map((p) => (
            <li
              key={p.pluginId}
              style={{
                background: '#FFFFFF',
                border: '1px solid #DBE1EA',
                borderRadius: 10,
                padding: 12,
                marginBottom: 8,
              }}
            >
              <Link href={`/plugins/${p.pluginId}`} style={{ color: '#2456B8', fontWeight: 600 }}>
                {p.repositoryFullName}
                {p.pluginPath === '.' ? '' : ` / ${p.pluginPath}`}
              </Link>
              <div style={{ color: '#526174', fontSize: 14 }}>
                <a href={p.repositoryHtmlUrl} style={{ color: '#526174' }}>
                  {p.repositoryHtmlUrl}
                </a>
                {p.isArchived ? ' · 已归档' : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
