/**
 * 「我的」栏目导航（个人中心的左侧栏，页面布局.md §10：桌面左侧导航，右侧内容）。
 *
 * 为什么只列三项：`页面布局.md` §10 规划了七栏（评测/整合包/导入投稿/收藏/通知/事项/设置），
 * 但其中整合包、导入投稿、收藏、事项**连表都没有**（见 `docs/HANDOFF.md`）。
 * 这里只摆已经真有页面的三栏，不给死链。
 *
 * 手机上由 `.side-nav` 的断点规则自动变成横向 chips（§10：手机为栏目选择或可展开导航）。
 * 服务端组件（无 hooks），可在任何页面里直接用。
 */

import Link from 'next/link';

type MeSection = 'reviews' | 'favorites' | 'notifications' | 'settings';

export function MeNav({ current }: { current: MeSection }) {
  return (
    <aside className="panel me-side" aria-label="个人中心栏目">
      <p className="side-title">我的</p>
      <nav className="side-nav">
        <Link href="/me" className={current === 'reviews' ? 'active' : ''} aria-current={current === 'reviews' ? 'page' : undefined}>
          <span>评测</span>
        </Link>
        <Link
          href="/me/favorites"
          className={current === 'favorites' ? 'active' : ''}
          aria-current={current === 'favorites' ? 'page' : undefined}
        >
          <span>收藏</span>
        </Link>
        <Link
          href="/me/notifications"
          className={current === 'notifications' ? 'active' : ''}
          aria-current={current === 'notifications' ? 'page' : undefined}
        >
          <span>通知</span>
        </Link>
        <Link
          href="/me/settings"
          className={current === 'settings' ? 'active' : ''}
          aria-current={current === 'settings' ? 'page' : undefined}
        >
          <span>个人设置</span>
        </Link>
      </nav>
    </aside>
  );
}