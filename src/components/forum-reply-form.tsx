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
import { ForumImageUpload } from './forum-image-upload';

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
  /**
   * 已上传的正文图片（attachment_files.id）。回复没有草稿层，附件引用只在提交
   * 那一刻随请求体一次送到服务端——不收集的话，图只以 Markdown 留在正文里，
   * 不算附件，别人也就读不到（媒体层按引用判可见性）。
   */
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState(!compact);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/forum/posts/' + postId + '/replies', {
        method: 'POST',
        json: {
          bodyMd: bodyMd.trim(),
          parentId,
          // 顶层回复才有图；回复的回复不带（服务端也会拒）
          attachmentIds: parentId === undefined ? attachmentIds : undefined,
        },
      });
      setBodyMd('');
      setAttachmentIds([]);
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
      {/* 回复的回复不能带图（使用者口径）：只有顶层回复给上传入口 */}
      {parentId === undefined ? (
        <ForumImageUpload
          disabled={busy}
          onInsert={(md) => setBodyMd((prev) => (prev ? prev + '\n\n' + md : md))}
          onUploaded={(fileId) =>
            setAttachmentIds((prev) => (prev.includes(fileId) ? prev : [...prev, fileId]))
          }
        />
      ) : null}
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
