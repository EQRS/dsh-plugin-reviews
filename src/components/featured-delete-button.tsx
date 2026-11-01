'use client';

/** 删除一期精选草稿（已发布的期不可删：历史链接要能打开）。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';

export function FeaturedDeleteButton({ issueNumber }: { issueNumber: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const remove = async () => {
    if (!window.confirm('删除第 ' + issueNumber + ' 期草稿？删除后不可恢复。')) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/featured/' + issueNumber, { method: 'DELETE' });
      const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !body.ok) {
        throw { code: 'request_failed', message: body.error?.message ?? '删除失败。' } as ApiError;
      }
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <button type="button" className="link-btn" disabled={busy} onClick={() => void remove()}>
        {busy ? '删除中…' : '删除'}
      </button>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </span>
  );
}
