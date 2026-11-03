'use client';

/**
 * 发帖表单：分区选择 + 标题 + Markdown 正文。
 *
 * 图片这一版先不做上传控件：附件上传链路是独立的（需要先传后引用），
 * 讨论区接它要另做一轮，这里先保证文字与 Markdown 能用。接口已经支持 fileIds。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { FORUM_LIMITS } from '@/packages/common/forum';

export function ForumPostForm({
  boards,
  initialBoard,
}: {
  boards: Array<{ slug: string; name: string }>;
  initialBoard: string;
}) {
  const router = useRouter();
  const [boardSlug, setBoardSlug] = useState(initialBoard);
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ postId: string }>('/api/forum/posts', {
        method: 'POST',
        json: { boardSlug, title: title.trim(), bodyMd: bodyMd.trim() },
      });
      router.push('/forum/' + boardSlug + '/' + result.postId);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {boards.length > 1 ? (
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="forum-board">分区</label>
          <select
            id="forum-board"
            value={boardSlug}
            onChange={(e) => setBoardSlug(e.target.value)}
            disabled={busy}
          >
            {boards.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="forum-title">标题</label>
        <input
          id="forum-title"
          type="text"
          value={title}
          maxLength={FORUM_LIMITS.postTitleMax}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          placeholder="一句话说清楚要聊什么"
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {title.length} / {FORUM_LIMITS.postTitleMax}
        </span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="forum-body">正文（支持 Markdown）</label>
        <textarea
          id="forum-body"
          value={bodyMd}
          rows={12}
          maxLength={FORUM_LIMITS.postBodyMax}
          onChange={(e) => setBodyMd(e.target.value)}
          disabled={busy}
          placeholder="想说什么就写在这儿。可以用 # 标题、- 列表、**加粗**。"
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {bodyMd.length} / {FORUM_LIMITS.postBodyMax}
        </span>
      </div>

      <button
        type="button"
        className="button"
        onClick={() => void submit()}
        disabled={busy || title.trim().length === 0 || bodyMd.trim().length === 0}
      >
        {busy ? '发布中…' : '发布'}
      </button>
    </div>
  );
}
