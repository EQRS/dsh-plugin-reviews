'use client';

/** 分区申请表单：名称 / 标识 / 描述 / 理由。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { FORUM_LIMITS } from '@/packages/common/forum';

export function ForumApplicationForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/forum/applications', {
        method: 'POST',
        json: {
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim(),
          reason: reason.trim(),
        },
      });
      setDone(true);
      setName('');
      setSlug('');
      setDescription('');
      setReason('');
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
      {done ? <p className="notice">已提交，管理员审核后会在通知里告诉你结果。</p> : null}

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="app-name">分区名称</label>
        <input
          id="app-name"
          type="text"
          value={name}
          maxLength={FORUM_LIMITS.boardNameMax}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="例如：机械键盘"
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="app-slug">标识（进网址用，只能小写字母、数字与连字符）</label>
        <input
          id="app-slug"
          type="text"
          value={slug}
          maxLength={FORUM_LIMITS.boardSlugMax}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          disabled={busy}
          placeholder="例如：keyboards"
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="app-desc">一句话说明（可选）</label>
        <input
          id="app-desc"
          type="text"
          value={description}
          maxLength={FORUM_LIMITS.boardDescriptionMax}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          placeholder="这个分区是聊什么的"
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="app-reason">申请理由</label>
        <textarea
          id="app-reason"
          value={reason}
          rows={5}
          maxLength={FORUM_LIMITS.applicationReasonMax}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          placeholder="为什么需要单独开一个分区？站内相关讨论有多少？你打算怎么管理？"
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {reason.length} / {FORUM_LIMITS.applicationReasonMax}
        </span>
      </div>

      <button
        type="button"
        className="button"
        onClick={() => void submit()}
        disabled={busy || name.trim().length === 0 || slug.trim().length === 0 || reason.trim().length === 0}
      >
        {busy ? '提交中…' : '提交申请'}
      </button>
    </div>
  );
}
