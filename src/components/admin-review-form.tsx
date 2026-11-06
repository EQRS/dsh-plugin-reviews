'use client';

/**
 * 后台审核动作的通用表单：通过 / 驳回。
 *
 * 两个队列（插件认领 / 身份申请）的交互完全一样——通过是一步、驳回必须先写理由，
 * 所以合并成一个组件，而不是抄两份各自维护。差异只剩三处，都用 props 表达：
 *  - `endpoint`：这一条记录提交到哪个接口（/api/admin/plugin-ownerships/{id} 等）；
 *  - `rejectPlaceholder`：理由框的提示语（两个场景要说的话不一样）；
 *  - `rejectNoteLabel`：理由框的无障碍标签。
 *
 * 三条界面要求（来自任务约定，不是装饰）：
 *  1. **空理由不能驳回**——按钮在理由为空时置灰，不给一个点了才知道失败的入口；
 *  2. **防重复点击**：busy 时两个按钮一起禁用，避免一次点击变成两次审核（第二次会撞 409；
 *     虽然服务端会挡住，但界面上出现一条"已经处理过了"的报错很像是自己点坏了）；
 *  3. 失败原样展示后端 message（`ErrorNotice`），不改写、不吞。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

/** 与库里 CHECK 一致：`review_note` / `claimed_note` 都是 `length(...) <= 500`。 */
const MAX_NOTE_LENGTH = 500;

export interface AdminReviewFormProps {
  /** 这一条记录的提交地址（已含 id）。 */
  endpoint: string;
  /** 通过时提交的 decision 取值，默认 'verify'。 */
  decisionVerify?: string;
  /** 驳回时提交的 decision 取值，默认 'reject'。 */
  decisionReject?: string;
  rejectPlaceholder?: string;
  rejectNoteLabel?: string;
}

export function AdminReviewForm({
  endpoint,
  decisionVerify = 'verify',
  decisionReject = 'reject',
  rejectPlaceholder = '驳回理由（必填，会通知申请人）',
  rejectNoteLabel = '驳回理由',
}: AdminReviewFormProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (decision: string, noteValue: string | null) => {
    // busy 期间再次触发（例如双击的第二下）直接忽略，不再发请求。
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch<unknown>(endpoint, { method: 'POST', json: { decision, note: noteValue } });
      // 重新拉服务端渲染的列表：处理过的那条会从「待审」里消失，不需要客户端自己猜。
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const trimmed = note.trim();
  const canReject = trimmed.length > 0;

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label htmlFor={`note-${endpoint}`} className="muted" style={{ fontSize: 13 }}>
        {rejectNoteLabel}
      </label>
      <textarea
        id={`note-${endpoint}`}
        value={note}
        maxLength={MAX_NOTE_LENGTH}
        rows={2}
        placeholder={rejectPlaceholder}
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 14 }}
      />
      <div className="list-meta">
        <span>
          {trimmed.length}/{MAX_NOTE_LENGTH}
        </span>
        <span>驳回必须写理由；通过可以不写。</span>
      </div>
      <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void submit(decisionVerify, trimmed.length > 0 ? trimmed : null)}
        >
          {busy ? '处理中…' : '通过'}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !canReject}
          title={canReject ? undefined : '请先填写驳回理由'}
          onClick={() => void submit(decisionReject, trimmed)}
        >
          驳回
        </button>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
