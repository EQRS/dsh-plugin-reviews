'use client';

/**
 * 管理员隐藏 / 取消隐藏内容。
 *
 * 几条界面口径：
 *  1. **两段式确认**：先点「隐藏内容」/「取消隐藏」展开确认区，填了原因再点「确认…」才发请求。
 *     隐藏会立刻影响读者，不能一键误触。
 *  2. 原因**两个方向都必填**。
 *  3. 隐藏状态在期间被改动时，请求会被拒成 409 `version_conflict`；
 *     冲突时提示"先刷新看最新状态"，**不自动重试**。
 *  4. **解除隐藏不等于恢复公开**：撤回状态独立生效，
 *     所以必须如实写出当前公开/撤回状态，不能把「已解除隐藏」写成「已公开」。
 *  5. 成功后**不立即刷新**（刷新会把说明冲掉），给一个显式的刷新入口。
 *  6. 重试可能拿到 409 而不是原结果，界面按"状态已变，先刷新"处理，不假称操作已完成。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

type Action = 'hide' | 'unhide';

interface ContentVisibilitySnapshot {
  publiclyVisible: boolean;
  withdrawn: boolean;
  hasPublishedRevision: boolean;
}

interface VisibilityResult {
  action: Action;
  hidden: boolean;
  publicly_visible: boolean;
  has_published_revision: boolean;
  withdrawn: boolean;
  control_version: number;
  hidden_at: number | null;
  replayed: boolean;
}

const LABELS: Record<Action, { open: string; confirm: string; busy: string; reason: string; placeholder: string }> = {
  hide: {
    open: '隐藏内容',
    confirm: '确认隐藏',
    busy: '隐藏中…',
    reason: '隐藏原因（必填）',
    placeholder: '例如：垃圾内容／侵权投诉成立',
  },
  unhide: {
    open: '取消隐藏',
    confirm: '确认取消隐藏',
    busy: '处理中…',
    reason: '解除隐藏的原因（必填）',
    placeholder: '例如：申诉通过，恢复可公开',
  },
};

export function AdminHideForm({
  contentId,
  controlVersion,
  hidden,
  visibility,
}: {
  contentId: string;
  /** 服务端渲染时读到的控制版本；期间被改动就会冲突，需要刷新。 */
  controlVersion: number;
  /** 当前是否隐藏。 */
  hidden: boolean;
  /** 公开 / 撤回状态；给了就在状态行里如实展示。 */
  visibility?: ContentVisibilitySnapshot;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // 每个方向各留一个键：失败重试复用，避免重试变成第二次操作。
  const [pendingKeys, setPendingKeys] = useState<Partial<Record<Action, string>>>({});
  const [done, setDone] = useState<string | null>(null);

  const submit = async (action: Action) => {
    const trimmed = reason.trim();
    if (trimmed === '') {
      setError(
        new ApiError(
          {
            code: 'input_invalid',
            message: action === 'hide' ? '请先填写隐藏原因。' : '请先填写解除隐藏的原因。',
          },
          400,
        ),
      );
      return;
    }

    setBusy(action);
    setError(null);
    const requestKey = pendingKeys[action] ?? newRequestKey();
    setPendingKeys((k) => ({ ...k, [action]: requestKey }));

    try {
      const result = await apiFetch<VisibilityResult>(
        `/api/admin/content/${encodeURIComponent(contentId)}/visibility`,
        {
          method: 'POST',
          json: {
            action,
            reason: trimmed,
            expectedVisibilityControlVersion: controlVersion,
            requestKey,
          },
        },
      );
      setPendingKeys({});
      setReason('');
      setOpen(null);
      if (result.action === 'hide') {
        setDone('已隐藏：读者看不到这条内容，原因已记录，历史修订仍然保留。');
      } else {
        // 如实报告恢复到了什么地步：解除隐藏只恢复「可公开」，撤回状态不受影响。
        setDone(
          result.withdrawn
            ? '已解除隐藏，但作者已撤回，所以仍不公开。'
            : result.has_published_revision
              ? '已解除隐藏：恢复「可公开」（本次不会重新发布，也不改写撤回状态）。'
              : '已解除隐藏，但没有有效公开修订，所以仍不公开。',
        );
      }
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div role="status" className="notice success" style={{ fontSize: 13 }}>
        {done}
        <div style={{ marginTop: 6 }}>
          <button type="button" onClick={() => router.refresh()} className="link-btn">
            刷新页面看最新状态
          </button>
        </div>
      </div>
    );
  }

  // 状态行：只写已知事实；缺 visibility 时不猜"公开"。
  const statusText = hidden
    ? '已隐藏（读者看不到）'
    : visibility === undefined
      ? '未隐藏'
      : visibility.publiclyVisible
        ? '公开可见'
        : visibility.withdrawn
          ? '未公开（作者已撤回）'
          : visibility.hasPublishedRevision
            ? '未公开'
            : '未公开（没有有效公开修订）';
  const statusClass = hidden
    ? 'tag danger'
    : visibility !== undefined && !visibility.publiclyVisible
      ? 'tag warn'
      : 'tag site';

  const target: Action = hidden ? 'unhide' : 'hide';

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16 }}>可见性</h2>
        <span className={statusClass}>{statusText}</span>
      </div>

      {open === null ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setOpen(target)} className="button">
            {LABELS[target].open}
          </button>
          {hidden ? (
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
              解除隐藏不会自动重新发布。
            </span>
          ) : null}
        </div>
      ) : (
        <div>
          <label htmlFor={`visibility-reason-${contentId}`} style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
            {LABELS[open].reason}
          </label>
          <input
            id={`visibility-reason-${contentId}`}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={LABELS[open].placeholder}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13 }}
          />
          {error ? (
            <div>
              <ErrorNotice error={error} onDismiss={() => setError(null)} />
              {error.code === 'version_conflict' ? (
                <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                  状态已变化或该请求已处理过，请
                  <button type="button" onClick={() => router.refresh()} className="link-btn">
                    刷新页面
                  </button>
                  后再试。
                </p>
              ) : null}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => void submit(open)}
              disabled={busy !== null}
              className="button primary"
            >
              {busy === open ? LABELS[open].busy : LABELS[open].confirm}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(null);
                setReason('');
                setError(null);
              }}
              disabled={busy !== null}
              className="button"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}