'use client';

/**
 * 「订阅精选」按钮（订阅的是栏目：之后每一期发布都会通知）。
 *
 * 未登录时按钮仍可见但点击跳到登录页 —— 隐藏它会让读者不知道有这个能力。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export function FeaturedSubscribeButton({
  initialSubscribed,
  authenticated,
  subscriberCount,
}: {
  initialSubscribed: boolean;
  authenticated: boolean;
  subscriberCount?: number;
}) {
  const router = useRouter();
  const [subscribed, setSubscribed] = useState(initialSubscribed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const toggle = async () => {
    if (!authenticated) {
      router.push('/onboarding?returnTo=/featured');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/featured/subscription', {
        method: subscribed ? 'DELETE' : 'POST',
      });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { subscribed?: boolean };
        error?: { message?: string };
      };
      if (!response.ok || !body.ok) {
        throw { code: 'request_failed', message: body.error?.message ?? '操作失败。' } as ApiError;
      }
      setSubscribed(body.data?.subscribed === true);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        type="button"
        className={subscribed ? 'button tonal' : 'button'}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {busy ? '处理中…' : subscribed ? '已订阅（新期会通知我）' : '订阅精选'}
      </button>
      {typeof subscriberCount === 'number' ? (
        <span className="muted" style={{ fontSize: 13 }}>
          {subscriberCount} 人订阅
        </span>
      ) : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
