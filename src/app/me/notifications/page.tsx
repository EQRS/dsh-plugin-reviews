/**
 * 通知页（`idea.md §11`）。
 *
 * 需要登录：未登录直接引导去登录，而不是显示空列表（空列表会让人以为"没人理我"）。
 *
 * 本轮修掉三处：
 *  1. **嵌套 `<main>`**：根布局已经渲染了 `<main>`，这里再包一层是无效语义
 *     （一个文档只能有一个 main），读屏与跳转链接都会指错，改成普通 `<div>`；
 *  2. **重定向参数名**：原来写 `?next=/me/notifications`，但 `/onboarding` 读的是
 *     `returnTo`（`safeReturnTo`），于是登录成功后**跳回首页而不是通知页**。现在用 returnTo；
 *  3. 补「我的」栏目行，让三个已有页面（评测／通知／个人设置）互相可达。
 */

import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../api/_lib/context';
import { NotificationList } from '@/components/notification-list';
import { MeNav } from '@/components/me-nav';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?returnTo=/me/notifications');

  return (
    <div>
      {/* 页标题与 /me、/me/settings 一致地放在分栏**之上**，左栏因此与右栏首行平齐 */}
      <h1>通知</h1>
      <div className="me-layout">
        <MeNav current="notifications" />
        <div>
          <NotificationList />
        </div>
      </div>
    </div>
  );
}