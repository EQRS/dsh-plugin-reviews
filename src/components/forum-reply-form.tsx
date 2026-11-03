'use client';

/**
 * 回复表单。
 *
 * compact = 挂在某条顶层回复下面，用于「回复这条回复」：只给一行输入，
 * 展开后才显示文本框。回复的回复不支持图片（使用者口径），所以这里没有上传入口。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { FORUM_LIMITS } from '@/packages/common/forum';

export function ForumReplyForm({
  postId,
  parentId,
  compact = false,
}: {
  postId: string;
  parentId?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [bodyMd, setBodyMd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState(!compact);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/forum/posts/' + postId + '/replies', {
        method: 'POST',
        json: { bodyMd: bodyMd.trim(), parentId },
      });
      setBodyMd('');
      if (compact) setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="link-btn muted" onClick={() => setOpen(true)}>
        回复
      </button>
    );
  }

  return (
    <div style={{ marginTop: compact ? 6 : 0 }}>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      <textarea
        value={bodyMd}
        rows={compact ? 2 : 4}
        maxLength={FORUM_LIMITS.replyBodyMax}
        onChange={(e) => setBodyMd(e.target.value)}
        disabled={busy}
        placeholder={parentId ? '回复这条回复…' : '写下你的回复…'}
        style={{ width: '100%' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
        <button
          type="button"
          className="button"
          onClick={() => void submit()}
          disabled={busy || bodyMd.trim().length === 0}
        >
          {busy ? '发送中…' : parentId ? '发送回复' : '发表回复'}
        </button>
        {compact ? (
          <button type="button" className="link-btn muted" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </button>
        ) : null}
      </div>
    </div>
  );
}
