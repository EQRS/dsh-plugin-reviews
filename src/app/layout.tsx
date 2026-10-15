/**
 * 根布局。视觉层在 src/app/globals.css（Hylab 深色设计系统）统一维护，
 * 这里只搭页头 / 正文 / 页脚骨架，并接入参照站同款的三件事：
 *   1. Google Fonts（Inter / Plus Jakarta Sans / Space Grotesk）—— 与参照
 *      `网站\HTML\index.html` 完全一致的字体栈；取不到时回落到系统中文字体；
 *   2. 「跳至主内容」链接：键盘用户不必逐个 Tab 穿过导航；
 *   3. 阅读进度条：强调色→青的渐变细线，随滚动推进（客户端小组件）。
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionNav } from '@/components/session-nav';
import { ReadingProgress } from '@/components/reading-progress';
import './globals.css';

export const metadata: Metadata = {
  title: 'DSH Plugin Review · 最小切片',
  description: '登录 → 收录插件 → 写/审/发一篇评测 → 评论',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta name="theme-color" content="#111318" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700;800&display=swap"
        />
      </head>
      <body>
        <a className="skip" href="#main-content">
          跳至主内容
        </a>
        <ReadingProgress />
        <header className="site-header">
          {/* 导航栏由客户端组件渲染：登录态来自 GET /api/session 的真实响应。 */}
          <SessionNav />
        </header>
        <main id="main-content" className="site-main">
          {children}
        </main>
        <footer className="footer">
          本页是最小功能切片的演示载体，不是完整站点；未实现范围见 README-切片说明.md。
        </footer>
      </body>
    </html>
  );
}