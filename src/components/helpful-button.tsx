'use client';

/**
 * 「有帮助」按钮（`idea.md §13`）：登录用户一人一票、再点取消。
 *
 * 初始值由服务端给（详情页已经查过库），点击后以接口返回为准 ——
 * 不用本地乐观计数，避免"界面 +1 但库里没写进去"这种假状态。
 */

import { useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function HelpfulButton({
  reviewId,
  initialCount,
  initialHelpful,
  authenticated,
}: {
  reviewId: string;
  initialCount: number;
  initialHelpful: boolean;
  authenticated: boolean;
}) {
  const [count, setCount] = useState(initialCount);
  const [helpful, setHelpful] = useState(initialHelpful);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const toggle = async () => {
    if (!authenticated) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ helpful: boolean; count: number }>(
        `/api/reviews/${encodeURIComponent(reviewId)}/helpful`,
        { method: 'POST' },
      );
      setHelpful(result.helpful);
      setCount(result.count);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy || !authenticated}
        title={authenticated ? '这篇文章对你有帮助吗？' : '登录后可以表达「有帮助」'}
        aria-pressed={helpful}
        style={{
          background: helpful ? 'var(--md-sys-color-primary)' : 'transparent',
          color: helpful ? 'var(--md-sys-color-on-primary)' : 'var(--accent)',
          border: `1px solid ${
            helpful ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-outline-variant)'
          }`,
          borderRadius: 999,
          padding: '3px 12px',
          cursor: authenticated ? 'pointer' : 'not-allowed',
          fontSize: 13,
        }}
      >
        👍 有帮助 {count}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
