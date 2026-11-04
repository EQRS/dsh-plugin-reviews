/**
 * /me/favorites → /me/favorites/plugins（设计文档 §4.3）。
 *
 * 收藏体系扩到三类内容之后，顶层这个路径只做重定向：老书签与老链接照旧能用，
 * 落地页是插件子页（0039 之前这里本来就只有插件收藏）。带 q 搜索参数时一并带过去。
 */

import { redirect } from 'next/navigation';
// 本页只做重定向，不再渲染任何内容——原先的那些组件都已搬到子页。


export const dynamic = 'force-dynamic';

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function FavoritesIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = (firstValue(sp.q) ?? '').trim().slice(0, 100);
  redirect(q ? `/me/favorites/plugins?q=${encodeURIComponent(q)}` : '/me/favorites/plugins');
}
