/**
 * 根布局。视觉 token 直接取自 design-system/dsh-plugin-review/MASTER.md。
 * 本切片不做视觉评审，只提供链路可点击的载体。
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'DSH Plugin Review · 最小切片',
  description: '登录 → 收录插件 → 写/审/发一篇评测 → 评论',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          background: '#F3F5F8',
          color: '#1E293B',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          fontSize: 16,
          lineHeight: 1.7,
        }}
      >
        <header
          style={{
            background: '#FFFFFF',
            borderBottom: '1px solid #DBE1EA',
            padding: '12px 16px',
          }}
        >
          <nav style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', gap: 16, alignItems: 'center' }}>
            <Link href="/" style={{ color: '#2456B8', fontWeight: 600, textDecoration: 'none' }}>
              DSH Plugin Review
            </Link>
            <Link href="/plugins" style={{ color: '#526174', textDecoration: 'none' }}>
              插件
            </Link>
            <Link href="/reviews" style={{ color: '#526174', textDecoration: 'none' }}>
              评测
            </Link>
            <Link href="/admin" style={{ color: '#526174', textDecoration: 'none' }}>
              后台
            </Link>
            <span style={{ marginLeft: 'auto' }}>
              <Link href="/me" style={{ color: '#526174', textDecoration: 'none' }}>
                我的
              </Link>
            </span>
          </nav>
        </header>
        <main style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>{children}</main>
        <footer style={{ maxWidth: 1200, margin: '0 auto', padding: 16, color: '#526174', fontSize: 14 }}>
          本页是最小功能切片的演示载体，不是完整站点；未实现范围见 README-切片说明.md。
        </footer>
      </body>
    </html>
  );
}
