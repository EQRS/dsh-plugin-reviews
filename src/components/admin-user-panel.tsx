'use client';

/**
 * 后台「用户管理」组：授予/撤销管理员、禁用/恢复账户。
 *
 * 规划要求"日常数据管理全部通过后台页面完成，不得要求管理员直接改数据库表"——
 * 在它之前只有 `scripts/grant-admin.mjs`（或手拼 SQL）。这里把那件事搬进页面。
 *
 * 三条界面纪律：
 *  1. **不假装成功**：失败原样显示服务端的 `code` 与说明（含"最后一个可用管理员"这类守卫拒绝），
 *     不做任何本地乐观改写；
 *  2. **版本号来自刚读到的列表**（`management_version` / `account_status_version`），
 *     不做缓存；服务端 CAS 不符时回 409，界面据此提示刷新（列表会自动重读）；
 *  3. **幂等键按"一次用户操作"生成，重试复用同一个**：失败时保留、成功后才丢弃
 *     ——否则重试会变成第二次操作（见 `api-client.ts` 的约定）。
 *
 * 守卫只在服务端是权威；界面把"唯一可用管理员"的按钮提前置灰并写明原因，
 * 是为了不摆一个点下去必然失败的按钮（服务端仍会拒绝）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface AdminUserJson {
  user_id: string;
  nickname: string;
  avatar_url: string | null;
  github_login: string | null;
  role: 'user' | 'admin';
  account_status: 'active' | 'disabled';
  management_version: number;
  account_status_version: number;
  created_at: number;
  last_login_at: number | null;
}

interface UsersResponse {
  users: AdminUserJson[];
  active_admin_count: number;
}

interface UserMutationResponse {
  user: AdminUserJson;
  changed: boolean;
  replayed: boolean;
  revoked_sessions: number;
}

/** 一次用户操作的幂等键缓存：失败保留（重试复用），成功丢弃（下次点击是新操作）。 */
type KeyStore = Map<string, string>;

export function AdminUserPanel() {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在进行的操作键（`<userId>:<action>`）；非空时禁用按钮，避免同一用户并发两次操作。 */
  const [busy, setBusy] = useState<string | null>(null);
  /** 每个用户的禁用原因输入（禁用时必须非空）。 */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const keysRef = useRef<KeyStore>(new Map());

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<UsersResponse>('/api/admin/users', { cache: 'no-store' });
      setData(result);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 唯一的写入入口：两种变更共用（body 里用 action 区分）。 */
  const mutate = useCallback(
    async (user: AdminUserJson, action: 'set_role' | 'set_status', body: Record<string, unknown>) => {
      const opKey = `${user.user_id}:${action}`;
      setBusy(opKey);
      setError(null);
      setNotice(null);
      try {
        if (!keysRef.current.has(opKey)) keysRef.current.set(opKey, newRequestKey());
        const requestKey = keysRef.current.get(opKey) as string;
        const result = await apiFetch<UserMutationResponse>(`/api/admin/users/${encodeURIComponent(user.user_id)}`, {
          method: 'PATCH',
          json: { action, ...body, request_key: requestKey },
        });
        // 成功了：这次操作结束，下一次点击必须是新键（否则会被判成重放而不生效）。
        keysRef.current.delete(opKey);
        setNotice(describeOutcome(user, result));
        setReasons((prev) => ({ ...prev, [user.user_id]: '' }));
        await load();
      } catch (e) {
        // 失败：**保留同一个键**，用户重试时复用，服务端才能认成同一次操作。
        setError(e as ApiError);
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const activeAdminCount = data?.active_admin_count ?? 0;
  const lastActiveAdminId = useMemo(() => {
    if (data === null || activeAdminCount !== 1) return null;
    const only = data.users.find((u) => u.role === 'admin' && u.account_status === 'active');
    return only?.user_id ?? null;
  }, [data, activeAdminCount]);

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>用户管理</h2>
      <p className="muted">
        授予/撤销管理员、禁用/恢复账户 —— 全部在站内完成，不需要再跑{' '}
        <code>scripts/grant-admin.mjs</code> 或手改数据库表。每次变更都留一条审计记录（谁、对谁、改了什么、为什么），
        并带版本号做并发保护：这里的操作**不能**让一个普通用户把自己变成管理员（服务端会先校验操作者是管理员）。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p className="notice success">{notice}</p> : null}

      {data === null ? (
        <p className="muted">正在读取用户…</p>
      ) : (
        <>
          <div className="list-meta" style={{ marginBottom: 8 }}>
            <span>共 {data.users.length} 名用户</span>
            <span>可用管理员 {data.active_admin_count} 名</span>
          </div>

          {data.active_admin_count <= 1 ? (
            <p className="notice warn">
              当前只有 {data.active_admin_count} 名可用管理员：撤销或禁用**最后一名可用管理员**会被服务端拒绝
              （系统必须至少保留一名能审核内容的管理员）。请先把另一名用户授予管理员，再处理这一名。
            </p>
          ) : null}

          {data.users.length === 0 ? (
            <p className="empty">库里还没有任何用户 —— 用户行由首次 GitHub 登录建立。</p>
          ) : (
            <ul className="item-list panel" style={{ padding: '4px 16px' }}>
              {data.users.map((user) => {
                const rowBusy = busy !== null;
                const isLastActiveAdmin = lastActiveAdminId === user.user_id;
                const reason = reasons[user.user_id] ?? '';
                const isAdmin = user.role === 'admin';
                const isActive = user.account_status === 'active';

                return (
                  <li className="item" key={user.user_id}>
                    <div className="item-body">
                      <h3>{user.nickname}</h3>

                      <div className="list-meta">
                        <span>GitHub：{user.github_login ?? '未绑定'}</span>
                        <span>注册：{formatDateTime(user.created_at)}</span>
                        <span>
                          最近登录：{user.last_login_at === null ? '从未登录' : formatDateTime(user.last_login_at)}
                        </span>
                        <span>
                          版本：管理 {user.management_version} · 状态 {user.account_status_version}
                        </span>
                      </div>

                      <div style={{ marginTop: 6 }}>
                        <span className={isAdmin ? 'tag site' : 'tag'}>{isAdmin ? '管理员' : '普通用户'}</span>
                        <span className={isActive ? 'tag' : 'tag danger'}>{isActive ? '账户正常' : '已禁用'}</span>
                        {isLastActiveAdmin ? <span className="tag warn">唯一可用管理员</span> : null}
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          gap: 10,
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          marginTop: 8,
                          fontSize: 14,
                        }}
                      >
                        {/* ---- 角色 ---- */}
                        {user.account_status === 'disabled' && !isAdmin ? (
                          <span className="muted" style={{ fontSize: 13 }}>
                            账户已禁用：先恢复才能授予管理员。
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="link-btn"
                            disabled={rowBusy || (isAdmin && isLastActiveAdmin)}
                            title={isAdmin && isLastActiveAdmin ? '最后一名可用管理员不能被撤销' : undefined}
                            onClick={() =>
                              void mutate(user, 'set_role', {
                                role: isAdmin ? 'user' : 'admin',
                                expected_management_version: user.management_version,
                              })
                            }
                          >
                            {isAdmin ? '撤销管理员' : '授予管理员'}
                          </button>
                        )}

                        {/* ---- 账户状态 ---- */}
                        <input
                          aria-label={`${user.nickname} 的状态变更原因`}
                          placeholder={isActive ? '禁用原因（必填，会写进审计）' : '恢复原因（必填）'}
                          value={reason}
                          onChange={(e) => setReasons((prev) => ({ ...prev, [user.user_id]: e.target.value }))}
                          style={{ flex: '1 1 220px', minWidth: 180 }}
                        />
                        <button
                          type="button"
                          className={isActive ? 'link-btn danger' : 'link-btn'}
                          disabled={
                            rowBusy ||
                            reason.trim() === '' ||
                            // 最后一名可用管理员：禁用会被拒绝。恢复操作不做限制。
                            (isActive && user.role === 'admin' && isLastActiveAdmin)
                          }
                          title={
                            isActive && user.role === 'admin' && isLastActiveAdmin
                              ? '最后一名可用管理员不能被禁用'
                              : reason.trim() === ''
                                ? '原因必填'
                                : undefined
                          }
                          onClick={() =>
                            void mutate(user, 'set_status', {
                              account_status: isActive ? 'disabled' : 'active',
                              reason,
                              expected_account_status_version: user.account_status_version,
                            })
                          }
                        >
                          {isActive ? '禁用账户' : '恢复账户'}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="muted" style={{ fontSize: 13 }}>
            禁用会**同时撤销该用户所有会话**（立刻踢下线，旧 Cookie 不再可用），并阻止其重新登录；
            恢复后旧会话不会复活，需要重新登录。界面上的按钮对"最后一名可用管理员"提前置灰，
            但真正的守卫在服务端：即使绕过界面，也一样会被拒绝（错误码 <code>forbidden</code>，附{' '}
            <code>error.context.guard = last_active_admin</code>）。
          </p>
        </>
      )}
    </section>
  );
}

/** 结果文案：重放与新执行分开说，避免"点了没变"看起来像失败。 */
function describeOutcome(before: AdminUserJson, result: UserMutationResponse): string {
  const who = `「${before.nickname}」`;
  const suffix = result.replayed ? '（重放：这一次没有重复执行）' : '';
  const roleChanged = before.role !== result.user.role;
  const statusChanged = before.account_status !== result.user.account_status;

  if (result.user.role === 'admin' && roleChanged) return `已授予 ${who} 管理员权限${suffix}。`;
  if (result.user.role === 'user' && roleChanged) return `已撤销 ${who} 的管理员权限${suffix}。`;
  if (result.user.account_status === 'disabled' && statusChanged) {
    return `已禁用 ${who}${suffix}，并撤销了 ${result.revoked_sessions} 个登录会话。`;
  }
  if (result.user.account_status === 'active' && statusChanged) return `已恢复 ${who}${suffix}。`;

  if (result.replayed) {
    return `${who} 的这次变更此前已执行过（重放），本次没有重复执行${suffix}。`;
  }
  if (!result.changed) return `${who} 的现状与请求一致，没有产生变更。`;
  return `已更新 ${who}${suffix}。`;
}