'use client';

/**
 * 管理员隐藏 / 取消隐藏内容（契约逐字对照
 * `src/app/api/admin/content/[contentId]/visibility/route.ts`）。
 *
 *   POST /api/admin/content/{contentId}/visibility
 *        { action: 'hide' | 'unhide', reason, expectedVisibilityControlVersion, requestKey }
 *     →  { action, hidden, publicly_visible, has_published_revision, withdrawn, control_version, hidden_at, replayed }
 *
 * 几条刻意的设计决定：
 *  1. **两段式确认**：先点「隐藏内容」/「取消隐藏」展开确认区，填了原因再点「确认…」才发请求。
 *     隐藏会立刻影响读者（内容从公开变不可见），不能一键误触。
 *  2. `reason` **两个方向都必填**（后端服务层同样强制：迁移里隐藏三件套必须"全空或全填"）。
 *     这里先拦一次省一趟往返，但**不代替后端校验**。
 *  3. `expectedVisibilityControlVersion` 来自服务端渲染时读到的控制版本，不能缓存：
 *     期间若被撤回/隐藏/解除隐藏，请求会被拒成 409 `version_conflict`。冲突时提示"先刷新看最新状态"，
 *     **不自动重试**（避免按旧版本连点）。
 *  4. **解除隐藏不等于恢复公开**：服务层语义是"恢复『可公开』"，撤回状态独立生效。
 *     所以这里必须如实写出当前公开/撤回状态，不能把「已解除隐藏」写成「已公开」。
 *  5. 成功后**不立即刷新**（刷新会把说明冲掉），给一个显式的刷新入口 —— 与 `withdraw-button` 一致。
 *  6. **重试可能拿到 409 而不是"幂等返回原结果"**：服务层对 hide/unhide 没有 `request_key` 去重
 *     （`docs/模块签名契约.md` §9.3 登记的已知缺口），所以界面把 409 当作"状态已变，先刷新"处理，
 *     并提示这一点，不假称操作已完成。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

type Action = 'hide' | 'unhide';

export interface ContentVisibilitySnapshot {
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
  /** 服务端渲染时读到的 `content_entities.visibility_control_version`：CAS 凭据，不可缓存。 */
  controlVersion: number;
  /** 当前是否隐藏（`hidden_at IS NOT NULL`）。 */
  hidden: boolean;
  /** `contentService.resolveVisibility` 的结果；给了就在状态行里如实展示公开 / 撤回状态。 */
  visibility?: ContentVisibilitySnapshot;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // 一次操作一个幂等键；失败重试复用（两个方向各留一个）。
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
        setDone('已隐藏：读者看不到这条内容，隐藏原因已记入库（隐藏人、隐藏时间成对保存）。历史修订不会被删除。');
      } else {
        // 如实报告恢复到了什么地步：解除隐藏只恢复「可公开」，撤回状态不受影响。
        setDone(
          result.withdrawn
            ? '已解除隐藏。但该内容仍处于「作者已撤回」状态，因此现在**仍然不公开** —— 需要作者重新提交并通过审核才会重新公开。'
            : result.has_published_revision
              ? '已解除隐藏：该内容恢复公开资格（存在有效公开修订，且未被作者撤回）。本次操作**不会**重新发布或改写撤回状态。'
              : '已解除隐藏。但该内容当前**没有有效公开修订**，所以仍然不公开 —— 解除隐藏只恢复「可公开」资格。',
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

  // 状态行：只写服务端给出的已知事实；缺 `visibility` 时不猜"公开"。
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

      <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
        控制版本 v{controlVersion}（用于防止按旧页面操作：状态被别人改过就会拒绝本次请求）。
        隐藏/取消隐藏都由管理员执行并**必须填写原因**，操作会写进内容实体的隐藏三件套。
      </p>

      {open === null ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setOpen(target)} className="button">
            {LABELS[target].open}
          </button>
          {hidden ? (
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
              取消隐藏**不会**自动重新发布，撤回状态也不受影响。
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
              隐藏后读者看不到这条内容（作者撤回与否无关）；历史修订仍然保留。
            </span>
          )}
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
          <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
            {open === 'hide'
              ? '原因必填：隐藏是管理操作，必须留下理由（会与隐藏人、隐藏时间一起记录）。'
              : '原因必填：解除隐藏同样是管理操作。解除隐藏只恢复「可公开」，**不会**重新发布内容。'}
          </p>
          {error ? (
            <div>
              <ErrorNotice error={error} onDismiss={() => setError(null)} />
              {error.code === 'version_conflict' ? (
                <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                  可能是状态已被其他操作（撤回 / 隐藏 / 解除隐藏）改变，也可能是这次请求此前已经处理过（服务层对隐藏操作没有幂等去重）。
                  请先
                  <button type="button" onClick={() => router.refresh()} className="link-btn">
                    刷新页面
                  </button>
                  看到最新状态再决定，不要按旧版本连点。
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