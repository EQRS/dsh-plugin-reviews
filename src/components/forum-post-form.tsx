'use client';

/**
 * 发帖表单：分区选择 + 标题 + Markdown 正文（可带图）。
 *
 * 草稿（设计文档 §3.6）：
 *   * "存草稿"随时可用，标题与正文都为空也能存——写一半关页面是正常操作。
 *   * 带 draftId 的保存是覆盖式更新，不新建第二条。
 *   * "发布"先发帖再删草稿；发帖失败则草稿原样留着，用户不必重打。
 *     这两步不放在一个事务里：发帖本身已经是事务，两条独立请求让失败边界更清楚
 *     （帖子发出去但删草稿失败，最坏是多一条可手工删的草稿，不会丢帖子）。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { FORUM_LIMITS } from '@/packages/common/forum';
import { ForumImageUpload } from './forum-image-upload';

export function ForumPostForm({
  boards,
  initialBoard,
  draft,
}: {
  boards: Array<{ id: string; slug: string; name: string }>;
  initialBoard: string;
  /** 从草稿续写时传入；没有就是发新帖。 */
  draft?: { draftId: string; boardId: string; boardSlug: string; title: string; bodyMd: string; fileIds: string[] };
}) {
  const router = useRouter();
  const [boardSlug, setBoardSlug] = useState(draft?.boardSlug ?? initialBoard);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [bodyMd, setBodyMd] = useState(draft?.bodyMd ?? '');
  const [draftId, setDraftId] = useState<string | null>(draft?.draftId ?? null);
  // 正文图片的文件 id（attachment_files.id）；上传控件回传的就是它
  const [attachmentIds, setAttachmentIds] = useState<string[]>(draft?.fileIds ?? []);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<ApiError | null>(null);

  const saveDraft = async (): Promise<string | null> => {
    setError(null);
    setSaveState('saving');
    try {
      // 发帖认 slug，存草稿认 boardId：两者由页面一并传进来，不在客户端猜
      const boardId = draft?.boardId ?? boards.find((b) => b.slug === boardSlug)?.id;
      const result = await apiFetch<{ draftId: string }>('/api/forum/drafts', {
        method: 'POST',
        json: {
          draftId: draftId ?? undefined,
          boardId: draftId === null ? boardId : undefined,
          title,
          bodyMd,
          attachmentIds,
        },
      });
      setDraftId(result.draftId);
      setSaveState('saved');
      return result.draftId;
    } catch (e) {
      setError(e as ApiError);
      setSaveState('idle');
      return null;
    }
  };

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ postId: string; pendingReview: boolean }>('/api/forum/posts', {
        method: 'POST',
        json: { boardSlug, title: title.trim(), bodyMd: bodyMd.trim(), attachmentIds },
      });
      // 帖子已落地就删草稿；删不掉也不拦着跳转（最坏留一条可手工删的草稿）
      if (draftId !== null) {
        await apiFetch('/api/forum/drafts/' + draftId, { method: 'DELETE' }).catch(() => undefined);
      }
      router.push('/forum/' + boardSlug + '/' + result.postId);
    } catch (e) {
      setError(e as ApiError);
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
            disabled={busy || draftId !== null}
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
        <ForumImageUpload
          disabled={busy}
          onInsert={(md) => setBodyMd((prev) => (prev ? prev + '\n\n' + md : md))}
          onUploaded={(fileId) =>
            setAttachmentIds((prev) => (prev.includes(fileId) ? prev : [...prev, fileId]))
          }
        />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="button"
          onClick={() => void publish()}
          disabled={busy || title.trim().length === 0 || bodyMd.trim().length === 0}
        >
          {busy ? '发布中…' : '发布'}
        </button>
        <button type="button" className="button secondary" onClick={() => void saveDraft()} disabled={busy || saveState === 'saving'}>
          {saveState === 'saving' ? '保存中…' : draftId !== null ? '更新草稿' : '存草稿'}
        </button>
        {saveState === 'saved' ? (
          <span className="muted" style={{ fontSize: 12 }}>
            已存草稿，可在「我的帖子」里继续写
          </span>
        ) : null}
      </div>
    </div>
  );
}
