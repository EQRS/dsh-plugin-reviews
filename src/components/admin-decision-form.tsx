'use client';

/**
 * 后台人工审核决定（把 /admin 从"只读待办表"变成真的能审）。
 *
 * 契约（逐字对照 src/app/api/admin/submissions/[submissionId]/decisions/route.ts）：
 *   POST /api/admin/submissions/{submissionId}/decisions
 *        { decision: 'approve' | 'needs_changes', reason, expectedStateVersion, requestKey }
 *     →  { state, publishTaskId, publishQueued }
 *
 * 几条刻意的设计决定：
 *  1. `reason` **必填**（后端也校验）。这里先拦一次，省一趟往返，但**不代替后端校验**。
 *  2. `expectedStateVersion` 必须来自服务端渲染时读到的 `state_version`，不能缓存：
 *     决定是 CAS，版本不符会 409。冲突时提示"刷新后重试"，不自动重试（避免按旧版本连点）。
 *  3. `requestKey` 一次操作一个，失败重试复用同一个 —— 否则重试会变成两次决定。
 *  4. **通过之后必须如实报告"发布有没有入队"**：`publishQueued=false` 意味着
 *     状态是 approved 但没有任何东西会去发布，界面上不能写成"已完成"。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle, newRequestKey, secondaryButtonStyle } from './api-client';

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
  // 一次决定一个幂等键；失败重试复用（每个方向各留一个）。
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
          text: `已通过，发布任务 ${result.publishTaskId} 已入队（由 worker 执行发布）。刷新列表后该项会移出待办。`,
          ok: true,
        });
      } else {
        setDone({
          text: '已通过，但**发布任务入队失败**：状态是 approved，可是没有任何东西会去发布，内容不会公开。请检查 worker 与 tasks 模块后重试。',
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
        style={{
          background: done.ok ? '#F0F7F2' : '#FFF7E6',
          border: `1px solid ${done.ok ? '#A9D5B8' : '#F0C36D'}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 13,
          color: done.ok ? '#1E5B32' : '#7A5B12',
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
            style={{ background: 'none', border: 'none', color: '#2456B8', cursor: 'pointer', padding: 0, fontSize: 13 }}
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
        style={{ ...inputStyle, fontSize: 13, padding: '6px 8px' }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void decide('approve')}
          disabled={busy !== null}
          style={{ ...buttonStyle, padding: '6px 10px', fontSize: 13 }}
        >
          {busy === 'approve' ? '处理中…' : '通过并发布'}
        </button>
        <button
          type="button"
          onClick={() => void decide('needs_changes')}
          disabled={busy !== null}
          style={{ ...secondaryButtonStyle, padding: '6px 10px', fontSize: 13 }}
        >
          {busy === 'needs_changes' ? '处理中…' : '需修改'}
        </button>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
