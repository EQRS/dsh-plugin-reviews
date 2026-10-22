'use client';

/**
 * 举报按钮（`idea.md §20`）：评测与评论共用这一个组件。
 *
 * 交互刻意做成"点开小表单"而不是 window.prompt：原因必须能选（五个固定项），
 * 补充说明可选 —— 这是管理员处理时的判据，不该让用户自己发挥。
 */

import { useState } from 'react';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

const REASONS: Array<{ value: string; label: string }> = [
  { value: 'spam', label: '垃圾广告' },
  { value: 'abuse', label: '辱骂或人身攻击' },
  { value: 'misinformation', label: '错误信息（含误导性实测结论）' },
  { value: 'copyright', label: '版权或抄袭' },
  { value: 'other', label: '其他（请补充说明）' },
];

export function ReportButton({
  targetKind,
  targetId,
  authenticated,
}: {
  targetKind: 'review' | 'comment' | 'pack_release';
  targetId: string;
  authenticated: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('spam');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ reportId: string; created: boolean }>('/api/reports', {
        method: 'POST',
        json: { targetKind, targetId, reason, detail: detail.trim() || undefined },
      });
      setDone(result.created ? '已提交举报，管理员处理后会在通知里告诉你结果。' : '你之前已经举报过这一项，我们还在处理中。');
      setOpen(false);
      setDetail('');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <button
        type="button"
        onClick={() => (authenticated ? setOpen((v) => !v) : setOpen(false))}
        disabled={!authenticated}
        title={authenticated ? '举报这一项' : '登录后才能举报'}
        style={{ background: 'none', border: 'none', color: 'var(--md-sys-color-error)', cursor: authenticated ? 'pointer' : 'not-allowed', padding: 0, fontSize: 13 }}
      >
        举报
      </button>

      {done ? <span style={{ color: 'var(--success-ink)' }}>{done}</span> : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {open ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(16,24,40,0.35)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 50,
          }}
          role="dialog"
          aria-label="举报"
        >
          <div
            style={{
              background: 'var(--md-sys-color-surface-container-high)',
              color: 'var(--md-sys-color-on-surface)',
              borderRadius: 12,
              padding: 18,
              width: 'min(480px, 92vw)',
            }}
          >
            <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>举报</h3>
            <label style={{ display: 'block', fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>原因</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                border: '1px solid var(--md-sys-color-outline-variant)',
                borderRadius: 8,
                marginBottom: 10,
                background: 'var(--md-sys-color-surface-container-lowest)',
                color: 'var(--md-sys-color-on-surface)',
              }}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <label style={{ display: 'block', fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>
              补充说明（可选，最多 2000 字）
            </label>
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={4}
              style={{
                width: '100%',
                padding: '6px 8px',
                border: '1px solid var(--md-sys-color-outline-variant)',
                borderRadius: 8,
                background: 'var(--md-sys-color-surface-container-lowest)',
                color: 'var(--md-sys-color-on-surface)',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  background: 'var(--md-sys-color-surface-container-high)',
                  border: '1px solid var(--md-sys-color-outline-variant)',
                  color: 'var(--md-sys-color-on-surface)',
                  borderRadius: 8,
                  padding: '6px 14px',
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                style={{
                  background: 'var(--md-sys-color-error)',
                  color: 'var(--md-sys-color-on-error)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '6px 14px',
                  cursor: 'pointer',
                }}
              >
                {busy ? '提交中…' : '提交举报'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  );
}
