'use client';

/** 整合包收藏按钮（与插件收藏同样的交互：一点收藏、再点取消）。 */

import { useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function PackFavoriteButton({
  packId,
  initialFavorited,
  initialCount,
  authenticated,
}: {
  packId: string;
  initialFavorited: boolean;
  initialCount: number;
  authenticated: boolean;
}) {
  const [favorited, setFavorited] = useState(initialFavorited);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const toggle = async () => {
    if (!authenticated) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ favorited: boolean }>(
        `/api/packs/${encodeURIComponent(packId)}/favorite`,
        { method: 'POST' },
      );
      setFavorited(result.favorited);
      setCount((c) => Math.max(0, c + (result.favorited ? 1 : -1)));
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
        aria-pressed={favorited}
        title={authenticated ? '收藏这个整合包（可在「我的 → 收藏」查看）' : '登录后可以收藏'}
        style={{
          background: favorited ? '#4e7a4e' : 'transparent',
          color: favorited ? '#FFFFFF' : 'var(--md-sys-color-primary, #2456B8)',
          border: '1px solid var(--md-sys-color-outline-variant, #DBE1EA)',
          borderRadius: 999,
          padding: '3px 12px',
          cursor: authenticated ? 'pointer' : 'not-allowed',
          fontSize: 13,
        }}
      >
        {favorited ? '★ 已收藏' : '☆ 收藏'} {count}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
