'use client';

/**
 * 新建收藏夹表单（只有收藏页顶层用它；收藏夹详情里不提供新建，避免嵌套收藏夹）。
 *
 * `kind` 决定这个夹属于哪一类内容（0039 之后夹按类型隔离，缺省仍是插件）。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FavoriteTargetKind } from '@/server/modules/interactions';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function CreateFolderForm({ kind = 'plugin' }: { kind?: FavoriteTargetKind }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/me/favorites/folders', { method: 'POST', json: { name: trimmed, kind } });
      setName('');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
      <input
        type="text"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        placeholder="新建收藏夹（1-40 字）"
        aria-label="新建收藏夹名称"
        style={{ flex: 1, minWidth: 180 }}
      />
      <button type="submit" className="button primary" disabled={busy || name.trim() === ''}>
        {busy ? '创建中…' : '新建收藏夹'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </form>
  );
}
