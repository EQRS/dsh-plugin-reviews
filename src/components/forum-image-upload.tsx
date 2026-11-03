'use client';

/**
 * 讨论区图片上传控件：登记 → PUT 字节 → 就绪后把 Markdown 图片语法插回正文。
 *
 * 与评测编辑器的上传是同一套链路（先登记拿附件 id，再 PUT 原始字节），
 * 差别只在登记入口：讨论区的图先传后引用，不挂在内容草稿上。
 *
 * 文字与插入的位置由父组件给回调负责——这个组件只管"把一张图变成一段
 * 可插进正文的 Markdown"，不碰正文内容。
 */

import { useRef, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

interface AttachmentView {
  attachmentId: string;
  processingState: string;
  displayUrl?: string | null;
  lastErrorCode?: string | null;
}

export function ForumImageUpload({
  onInsert,
  onUploaded,
  disabled,
}: {
  /** 拿到可用的图片地址后，由父组件决定插到哪里。 */
  onInsert: (markdown: string) => void;
  /** 图片就绪时回调附件 id：发帖/回复的 fileIds 靠它收集，否则图只在正文里、不算附件。 */
  onUploaded?: (fileId: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (!ALLOWED_MIME.includes(file.type)) {
        throw new ApiError(
          { code: 'input_invalid', message: '只支持 PNG / JPEG / WebP。' },
          400,
        );
      }
      if (file.size > MAX_BYTES) {
        throw new ApiError(
          { code: 'input_invalid', message: '单张图片最多 10MB。' },
          400,
        );
      }

      const registered = await apiFetch<{ attachmentId: string; uploadUrl: string }>('/api/forum/attachments', {
        method: 'POST',
        json: { originalFilename: file.name },
      });

      const ready = await apiFetch<AttachmentView>(registered.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });

      if (ready.processingState === 'ready' && ready.displayUrl) {
        onInsert('![' + file.name + '](' + ready.displayUrl + ')');
        // 只有就绪的图才登记成附件：处理中的图引用进来也打不开
        onUploaded?.(ready.attachmentId);
        setNote('图片已插入正文。');
        return;
      }
      if (ready.processingState === 'failed') {
        throw new ApiError(
          {
            code: 'input_invalid',
            message: '图片处理失败' + (ready.lastErrorCode ? '（' + ready.lastErrorCode + '）' : '') + '，请换一张。',
          },
          400,
        );
      }
      // 还在处理中：不是失败，如实说明
      setNote('图片还在处理中，稍后刷新可以看到。');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div style={{ marginTop: 6 }}>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {note ? (
        <p className="muted" style={{ fontSize: 12, margin: '0 0 6px' }}>
          {note}
        </p>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        className="link-btn"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? '上传中…' : '插入图片'}
      </button>
    </div>
  );
}
