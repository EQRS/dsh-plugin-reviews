'use client';

/** 后台审批控件：通过 / 拒绝。拒绝必须写理由。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function ForumApplicationReview({ applicationId }: { applicationId: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/admin/forum/applications/' + applicationId, {
        method: 'POST',
        json: { action, note: note.trim() || undefined },
      });
      setNote('');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      <textarea
        value={note}
        rows={2}
        maxLength={1000}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
        placeholder="审核意见（拒绝时必填，会发给申请人）"
        style={{ width: '100%' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button type="button" className="button" onClick={() => void decide('approve')} disabled={busy}>
          {busy ? '处理中…' : '通过'}
        </button>
        <button
          type="button"
          className="button tonal"
          onClick={() => void decide('reject')}
          disabled={busy || note.trim().length === 0}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
