/**
 * 页面级「返回…」按钮（统一形态与位置）。
 *
 * 之前全站这类链接至少有三种样子：页面底部的裸文字链接（`← 返回插件目录`）、
 * 侧栏里的 muted 链接、以及行内链接 —— 位置与形态都不统一。
 * 现在统一成"内容最上方的一个小药丸"，样式在 globals.css 的 `.back-link`。
 *
 * 服务端组件（无 hooks），任何页面都能直接用。
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="back-link">
      <span aria-hidden="true">←</span>
      <span>{children}</span>
    </Link>
  );
}