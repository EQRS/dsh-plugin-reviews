/**
 * 根布局。视觉 token 在 src/app/globals.css 统一定义（逐字取自
 * design-system/dsh-plugin-review/MASTER.md），这里只搭页头 / 正文 / 页脚骨架。
 *
 * 页面布局.md §12 的两条硬要求在这一层落实：
 *  - 「跳至主内容」链接：键盘用户不必逐个 Tab 穿过导航；
 *  - 页头与正文同容器宽度（1200px），放大与长标签不互相挤压。
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionNav } from '@/components/session-nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'DSH Plugin Review · 最小切片',
  description: '登录 → 收录插件 → 写/审/发一篇评测 → 评论',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip" href="#main-content">
          跳至主内容
        </a>
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
