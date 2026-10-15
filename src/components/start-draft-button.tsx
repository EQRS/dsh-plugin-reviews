'use client';

/**
 * "写评测"入口（任务 7 的补缺项）。
 *
 * 为什么需要它：编辑器页 `/me/drafts/[draftId]` 需要先有一个 draftId，
 * 而 `POST /api/drafts`（新建/复用草稿）此前**没有任何界面调用它** ——
 * 结果是用户走到 /me 看到"暂无草稿"，却没有任何按钮能开始写，
 * 整条链路在最后一步断掉。
 *
 * 幂等语义：一次点击生成一个 requestKey；失败重试复用同一个键，
 * 避免重试时重复建草稿。
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
        {busy ? '正在建立草稿…' : pendingKey ? '重试新建草稿' : '写一篇评测'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
