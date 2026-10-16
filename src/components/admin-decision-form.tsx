'use client';

/**
 * 后台人工审核决定（"通过并发布 / 需修改"）。
 *
 * 几点界面口径：
 *  1. 原因**必填**；
 *  2. 版本冲突时提示"刷新后再试"，不自动重试；
 *  3. 通过之后如实报告"发布有没有入队"：入队失败时内容不会公开，
 *     界面上不能写成"已完成"。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface DecideResult {
  state: string;
  publishTaskId: string | null;
  publishQueued: boolean;
}

type Decision = 'approve' | 'needs_changes';

export function AdminDecisionForm({
  submissionId,
  stateVersion,
}: {
  submissionId: string;
  stateVersion: number;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ text: string; ok: boolean } | null>(null);
  // 每个方向各留一个键：失败重试复用，避免重试变成两次决定。
  const [pendingKeys, setPendingKeys] = useState<Partial<Record<Decision, string>>>({});

  const decide = async (decision: Decision) => {
    if (reason.trim() === '') {
      setError(new ApiError({ code: 'input_invalid', message: '请先填写处理原因。' }, 400));
      return;
    }
    setBusy(decision);
    setError(null);
    setDone(null);

    const requestKey = pendingKeys[decision] ?? newRequestKey();
    setPendingKeys((k) => ({ ...k, [decision]: requestKey }));

    try {
      const result = await apiFetch<DecideResult>(
        `/api/admin/submissions/${encodeURIComponent(submissionId)}/decisions`,
        {
          method: 'POST',
          json: {
            decision,
            reason,
            expectedStateVersion: stateVersion,
            requestKey,
          },
        },
      );
      setPendingKeys({});
      setReason('');

      if (decision === 'needs_changes') {
        setDone({ text: '已标记为「需修改」。作者可以修改后重新提交，内容未公开。', ok: true });
      } else if (result.publishQueued) {
        setDone({
          text: '已通过并排入发布，稍后由 worker 发布。刷新列表后该项会移出待办。',
          ok: true,
        });
      } else {
        setDone({
          text: '已通过，但发布没有排上：内容不会公开。请检查 worker 是否在运行，然后重试。',
          ok: false,
        });
      }
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div
        role={done.ok ? 'status' : 'alert'}
        className={done.ok ? 'notice success' : 'notice danger'}
        style={{
          fontSize: 13,
          maxWidth: 360,
        }}
      >
        {done.text}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => {
              setDone(null);
              router.refresh();
            }}
            className="link-btn"
          >
            刷新列表
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minWidth: 280 }}>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="处理原因（必填，会记入处理记录）"
        style={{ width: '100%', fontSize: 13 }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void decide('approve')}
          disabled={busy !== null}
          className="button primary"
        >
          {busy === 'approve' ? '处理中…' : '通过并发布'}
        </button>
        <button
          type="button"
          onClick={() => void decide('needs_changes')}
          disabled={busy !== null}
          className="button"
        >
          {busy === 'needs_changes' ? '处理中…' : '需修改'}
        </button>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
