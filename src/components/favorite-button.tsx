'use client';

/**
 * 收藏按钮（`idea.md §15`）：登录用户可在插件详情页收藏 / 取消收藏。
 * 初始状态由服务端给（详情页已查过库），点击后以接口返回为准。
 */

import { useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function FavoriteButton({
  pluginId,
  initialFavorited,
  authenticated,
}: {
  pluginId: string;
  initialFavorited: boolean;
  authenticated: boolean;
}) {
  const [favorited, setFavorited] = useState(initialFavorited);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const toggle = async () => {
    if (!authenticated) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ favorited: boolean }>('/api/me/favorites', {
        method: 'POST',
        json: { kind: 'plugin', targetId: pluginId },
      });
      setFavorited(result.favorited);
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
        title={authenticated ? '收藏这个插件，可在「我的 → 收藏」里找到' : '登录后可以收藏'}
        aria-pressed={favorited}
        style={{
          background: favorited ? 'var(--md-sys-color-primary)' : 'transparent',
          color: favorited ? 'var(--md-sys-color-on-primary)' : 'var(--accent)',
          border: `1px solid ${
            favorited ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-outline-variant)'
          }`,
          borderRadius: 999,
          padding: '3px 12px',
          cursor: authenticated ? 'pointer' : 'not-allowed',
          fontSize: 13,
        }}
      >
        {favorited ? '★ 已收藏' : '☆ 收藏'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
