'use client';

/** 编辑帖子表单：与发帖共用同一套字段限制。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { FORUM_LIMITS } from '@/packages/common/forum';

export function ForumPostEditForm({
  postId,
  initialTitle,
  initialBody,
  returnHref,
}: {
  postId: string;
  initialTitle: string;
  initialBody: string;
  returnHref: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [bodyMd, setBodyMd] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/forum/posts/' + postId, {
        method: 'PATCH',
        json: { title: title.trim(), bodyMd: bodyMd.trim() },
      });
      router.push(returnHref);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="edit-title">标题</label>
        <input
          id="edit-title"
          type="text"
          value={title}
          maxLength={FORUM_LIMITS.postTitleMax}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="edit-body">正文（支持 Markdown）</label>
        <textarea
          id="edit-body"
          value={bodyMd}
          rows={12}
          maxLength={FORUM_LIMITS.postBodyMax}
          onChange={(e) => setBodyMd(e.target.value)}
          disabled={busy}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="button"
          onClick={() => void save()}
          disabled={busy || title.trim().length === 0 || bodyMd.trim().length === 0}
        >
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="link-btn muted" onClick={() => router.push(returnHref)} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}
