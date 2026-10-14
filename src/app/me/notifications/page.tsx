/**
 * 通知页（`idea.md §11`）。
 *
 * 需要登录：未登录直接引导去登录，而不是显示空列表（空列表会让人以为"没人理我"）。
 */

import { redirect } from 'next/navigation';
import { isAuthenticated } from '@/server/platform/context';
import { currentContext } from '../../api/_lib/context';
import { NotificationList } from '@/components/notification-list';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const ctx = await currentContext();
  if (!isAuthenticated(ctx)) redirect('/onboarding?next=/me/notifications');

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>
      <NotificationList />
    </main>
  );
}
