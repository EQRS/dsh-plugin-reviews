/**
 * 根布局。视觉 token 直接取自 design-system/dsh-plugin-review/MASTER.md。
 * 本切片不做视觉评审，只提供链路可点击的载体。
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionNav } from '@/components/session-nav';

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
          {/* 导航栏由客户端组件渲染：登录态来自 GET /api/session 的真实响应。 */}
          <SessionNav />
        </header>
        <main style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>{children}</main>
        {/*
          渲染后 Markdown 正文的基础样式。刻意保持极简：
          本切片不做视觉评审，但如果标题/列表/图片没有基本间距，正文会难读。
        */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              .review-body h1, .review-body h2, .review-body h3 { line-height: 1.35; margin: 1.4em 0 .6em; }
              .review-body h2 { font-size: 20px; border-bottom: 1px solid #DBE1EA; padding-bottom: .3em; }
              .review-body h3 { font-size: 17px; }
              .review-body p { margin: .8em 0; }
              .review-body ul, .review-body ol { padding-left: 1.6em; margin: .8em 0; }
              .review-body li { margin: .3em 0; }
              .review-body img { max-width: 100%; height: auto; border: 1px solid #DBE1EA; border-radius: 8px; }
              .review-body pre { background: #F3F5F8; border: 1px solid #DBE1EA; border-radius: 8px; padding: 12px; overflow-x: auto; }
              .review-body code { font-family: ui-monospace, Consolas, monospace; font-size: 14px; }
              .review-body :not(pre) > code { background: #F3F5F8; border-radius: 4px; padding: 1px 5px; }
              .review-body table { border-collapse: collapse; margin: .8em 0; }
              .review-body th, .review-body td { border: 1px solid #DBE1EA; padding: 6px 10px; text-align: left; }
              .review-body blockquote { margin: .8em 0; padding-left: 12px; border-left: 3px solid #DBE1EA; color: #526174; }
              .review-body a { color: #2456B8; }
            `,
          }}
        />
        <footer style={{ maxWidth: 1200, margin: '0 auto', padding: 16, color: '#526174', fontSize: 14 }}>
          本页是最小功能切片的演示载体，不是完整站点；未实现范围见 README-切片说明.md。
        </footer>
      </body>
    </html>
  );
}
