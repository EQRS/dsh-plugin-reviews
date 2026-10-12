'use client';

/**
 * 作者撤回自己的已发布评测（契约见 src/app/api/reviews/[reviewId]/withdraw/route.ts）。
 *
 *   POST /api/reviews/{reviewId}/withdraw
 *        { expectedControlVersion, requestKey, reason? } → { withdrawnAt }
 *
 * 几条刻意的设计决定：
 *  1. **两段式**：先点「撤回这篇评测」展开确认区，再点「确认撤回」才真的发请求。
 *     撤回是不可从界面撤销的动作（重新公开要重新提交并通过检查），不能一键误触。
 *  2. `expectedControlVersion` 来自服务端渲染时读到的控制版本 —— 它是"你看到的这一版"的凭据：
 *     若期间内容已被改动（撤回/隐藏/重新发布过），请求会被拒，而不是撤回一份你没看过的新内容。
 *  3. 撤回**不删除历史**：公开修订指针保留，只是不再公开。这一点必须在界面上说清楚，
 *     否则作者会以为"撤回 = 销毁"，反而不敢用。
 *  4. 成功后**不立即刷新**：刷新会让整页变成"作者已撤回"、把说明冲掉。给一个显式的刷新入口。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle, newRequestKey, secondaryButtonStyle } from './api-client';

export function WithdrawButton({
  reviewId,
  expectedControlVersion,
}: {
  reviewId: string;
  expectedControlVersion: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const requestKey = pendingKey ?? newRequestKey();
    setPendingKey(requestKey);

    try {
      await apiFetch<{ withdrawnAt: number }>(`/api/reviews/${encodeURIComponent(reviewId)}/withdraw`, {
        method: 'POST',
        json: {
          expectedControlVersion,
          requestKey,
          reason: reason.trim() === '' ? null : reason.trim(),
        },
      });
      setPendingKey(null);
      setOpen(false);
      setDone('已撤回。这篇评测不再对读者公开，历史修订仍然保留（不会被删除）。');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div
        role="status"
        style={{
          background: '#F0F7F2',
          border: '1px solid #A9D5B8',
          borderRadius: 8,
          padding: 10,
          fontSize: 13,
          color: '#1E5B32',
        }}
      >
        {done}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => router.refresh()}
            style={{ background: 'none', border: 'none', color: '#2456B8', cursor: 'pointer', padding: 0, fontSize: 13 }}
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ ...secondaryButtonStyle, fontSize: 13, padding: '6px 10px' }}>
        撤回这篇评测
      </button>
    );
  }

  return (
    <div>
      <label htmlFor={`withdraw-reason-${reviewId}`} style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        撤回原因（可选）
      </label>
      <input
        id={`withdraw-reason-${reviewId}`}
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="例如：数据有误，先撤下"
        style={{ ...inputStyle, fontSize: 13, padding: '6px 8px' }}
      />
      <p style={{ color: '#526174', fontSize: 12, margin: '6px 0' }}>
        撤回后读者看不到这篇评测（显示「作者已撤回」）。**内容不会被删除**，
        历史修订留在库里；想重新公开需要修改后重新提交审核。
      </p>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          style={{ ...buttonStyle, fontSize: 13, padding: '6px 10px' }}
        >
          {busy ? '撤回中…' : '确认撤回'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
          style={{ ...secondaryButtonStyle, fontSize: 13, padding: '6px 10px' }}
        >
          取消
        </button>
      </div>
    </div>
  );
}
