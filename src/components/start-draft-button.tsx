'use client';

/**
 * "写一篇评测"入口：点一次建一份草稿，然后进编辑器。
 *
 * 一次点击生成一个 requestKey；失败重试复用同一个键，避免重试时重复建草稿。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface CreatedDraft {
  draftId: string;
  reviewId: string;
  saveVersion: number;
}

export function StartDraftButton({ pluginId = null }: { pluginId?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const requestKey = pendingKey ?? newRequestKey();
    setPendingKey(requestKey);
    try {
      const draft = await apiFetch<CreatedDraft>('/api/drafts', {
        method: 'POST',
        json: { requestKey, pluginId },
      });
      setPendingKey(null);
      router.push(`/me/drafts/${draft.draftId}`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" onClick={() => void start()} disabled={busy} className="button primary">
        {busy ? '正在创建草稿…' : pendingKey ? '重试创建草稿' : '写一篇评测'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
