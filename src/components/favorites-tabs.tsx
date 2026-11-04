/**
 * 收藏分类切换条（插件 / 整合包 / 帖子）。
 *
 * 三类内容共用一个收藏夹体系（迁移 0039），但夹只装同类，所以页面按类型分三个子页：
 * /me/favorites/plugins · /packs · /posts。老链接 /me/favorites 现在重定向到 /plugins。
 */

import Link from 'next/link';
import type { FavoriteTargetKind } from '@/server/modules/interactions';

const TABS: Array<{ kind: FavoriteTargetKind; href: string; label: string }> = [
  { kind: 'plugin', href: '/me/favorites/plugins', label: '收藏的插件' },
  { kind: 'pack', href: '/me/favorites/packs', label: '收藏的整合包' },
  { kind: 'post', href: '/me/favorites/posts', label: '收藏的帖子' },
];

export function FavoritesTabs({ current }: { current: FavoriteTargetKind }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {TABS.map((t) => (
        <Link key={t.kind} href={t.href} className={t.kind === current ? 'button primary' : 'button'}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
