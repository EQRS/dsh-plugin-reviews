'use client';

/**
 * 身份申请面板（设计 §5.1）。
 *
 * 面板要能在五种情形下都说得清，不做「点了才知道不行」的入口：
 *   * 已持有  → 无按钮，说明「已是测评员」
 *   * 审核中  → 无按钮，给「撤回」
 *   * 冷却中  → 按钮置灰，写明驳回理由与剩余天数
 *   * 资格够  → 可点「申请」
 *   * 资格缺  → 按钮置灰，并把人引到该去的地方（写测评 / 认领插件）
 *
 * 判定逻辑在 @/packages/common/roles 的 decideRoleAction（纯函数、可测），
 * 这里只负责把结论画出来。**不要在这里另写一套 if 判断**，否则两处口径会漂。
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';
import { ROLE_CONDITIONS, ROLE_LABELS, type RoleActionDecision, type RolePanelView, type RoleType } from '@/packages/common/roles';

export function RoleApplicationPanel({
  panel,
  cooldownDays,
}: {
  panel: RolePanelView;
  /** 冷却天数（设置项）。**服务端保证这个数字与判定用的是同一个**，不在这里再读一次设置。 */
  cooldownDays: number;
}) {
  const router = useRouter();
  const [busyType, setBusyType] = useState<RoleType | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = async (type: RoleType) => {
    setBusyType(type);
    setError(null);
    setNotice(null);
    try {
      await apiFetch('/api/me/roles/applications', { method: 'POST', json: { roleType: type } });
      setNotice(`${ROLE_LABELS[type]}申请已提交，等待管理员审核。`);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusyType(null);
    }
  };

  const withdraw = async (action: RoleActionDecision) => {
    if (!action.pendingApplicationId) return;
    setBusyType(action.type);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/me/roles/applications/${encodeURIComponent(action.pendingApplicationId)}`, {
        method: 'DELETE',
      });
      setNotice(`已撤回${ROLE_LABELS[action.type]}申请。`);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusyType(null);
    }
  };

  return (
    <section className="panel" aria-label="申请身份">
      <div className="section-head">
        <h2>申请身份</h2>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        身份需要主动申请，由管理员审核后发放。两类身份互不冲突，可以同时持有。
        被驳回后需等待 {cooldownDays} 天才能再次申请。
      </p>

      <ul className="item-list">
        {panel.actions.map((action) => {
          const label = ROLE_LABELS[action.type];
          const busy = busyType === action.type;
          const hintHref = action.type === 'developer' ? '/me/my-plugins' : '/me';
          return (
            <li key={action.type} className="item" style={{ display: 'block' }}>
              <div className="item-body">
                <h3>
                  {label}
                  {action.state === 'held' ? (
                    <span className="tag site" style={{ marginLeft: 8 }}>
                      已持有
                    </span>
                  ) : null}
                  {action.state === 'pending' ? (
                    <span className="tag warn" style={{ marginLeft: 8 }}>
                      审核中
                    </span>
                  ) : null}
                </h3>
                <div className="list-meta">
                  <span>{ROLE_CONDITIONS[action.type]}</span>
                </div>
                <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
                  {action.progressText}
                  {action.statusText ? `　${action.statusText}` : ''}
                </p>

                <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {action.state === 'held' ? null : action.state === 'pending' ? (
                    action.canWithdraw ? (
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => void withdraw(action)}
                      >
                        {busy ? '撤回中…' : '撤回申请'}
                      </button>
                    ) : null
                  ) : action.disabled ? (
                    <>
                      <button type="button" className="button" disabled>
                        {action.buttonLabel}
                      </button>
                      {action.state === 'ineligible' ? (
                        <Link href={hintHref} style={{ fontSize: 13 }}>
                          去补条件
                        </Link>
                      ) : null}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => void apply(action.type)}
                    >
                      {busy ? '提交中…' : action.buttonLabel}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {notice ? (
        <p className="notice" style={{ marginBottom: 0 }}>
          {notice}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </section>
  );
}
