'use client';

/** 管理员处理表单：动作 + 必填理由 + 给提交人的回复（可选） + 重复目标（仅 duplicate）。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, SuccessNotice } from './api-client';
import { FEEDBACK_ACTIONS, FEEDBACK_ACTION_LABELS } from '@/packages/common/feedback';
import type { FeedbackAction } from '@/packages/common/feedback';

export function FeedbackHandleForm({
  ticketId,
  currentStatus,
}: {
  ticketId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const isTerminal = ['fixed', 'duplicate', 'wontfix', 'unreproducible'].includes(currentStatus);
  const defaultAction: FeedbackAction = isTerminal ? 'reopen' : 'acknowledge';
  const [action, setAction] = useState<FeedbackAction>(defaultAction);
  const [reason, setReason] = useState('');
  const [replyText, setReplyText] = useState('');
  const [duplicateOf, setDuplicateOf] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const actions = isTerminal ? (['reopen'] as const) : FEEDBACK_ACTIONS.filter((a) => a !== 'reopen');
  const canSubmit = reason.trim().length > 0 && (action !== 'duplicate' || duplicateOf.trim().length > 0);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/feedback/' + ticketId + '/handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          reason,
          replyText: replyText.trim() === '' ? null : replyText,
          duplicateOf: action === 'duplicate' ? duplicateOf : null,
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '处理失败。' } as ApiError;
      }
      setNotice('已处理。');
      setReason('');
      setReplyText('');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <p style={{ margin: '0 0 6px', fontSize: 13 }}>处理动作</p>
        <div className="filters" style={{ marginBottom: 0 }}>
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className={action === a ? 'button primary' : 'button'}
              onClick={() => setAction(a)}
            >
              {FEEDBACK_ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      </div>

      {action === 'duplicate' ? (
        <label style={{ fontSize: 13 }}>
          重复于哪一条（填对方的反馈 id）
          <input
            value={duplicateOf}
            onChange={(e) => setDuplicateOf(e.target.value)}
            style={{ width: '100%', display: 'block' }}
          />
        </label>
      ) : null}

      <label style={{ fontSize: 13 }}>
        处理理由（必填，内部留痕）
        <textarea
          value={reason}
          rows={3}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: '100%', display: 'block' }}
        />
      </label>

      <label style={{ fontSize: 13 }}>
        给提交人的回复（可选；留空时通知里只显示处理结果与理由）
        <textarea
          value={replyText}
          rows={3}
          maxLength={2000}
          onChange={(e) => setReplyText(e.target.value)}
          style={{ width: '100%', display: 'block' }}
        />
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="button primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
          {busy ? '处理中…' : '提交处理'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>处理结果会通过站内通知发给提交人。</span>
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
