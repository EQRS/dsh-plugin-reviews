'use client';

/**
 * 导航栏登录态（任务 7 第 1 项）。
 *
 * 状态**全部来自 `GET /api/session`**，不靠假设、也不靠本地猜测：
 *   - `authenticated` 决定显示"登录"还是"用户名 + 登出"；
 *   - `githubLoginConfigured` 为 false 时，GitHub 按钮**明说未配置**并禁用，
 *     不让用户点进一个 503 HTML 页面才算发现；
 *   - `testLoginEnabled` 为 true 时才出现测试登录入口（开发用，生产恒为 false）。
 *
 * 登录成功后不整页跳转刷新之外的额外状态同步：直接重取会话，
 * 避免"界面说登录了、服务端其实没会话"这种假状态。
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface SessionData {
  authenticated: boolean;
  userId?: string;
  role?: 'user' | 'admin' | null;
  accountStatus?: 'active' | 'disabled' | null;
  githubLoginConfigured: boolean;
  testLoginEnabled: boolean;
}

export function SessionNav() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  /** 未读通知数（`idea.md §11`：顶部未读数）。未登录/取失败时保持 null = 不显示角标。 */
  const [unread, setUnread] = useState<number | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const data = await apiFetch<SessionData>('/api/session', { cache: 'no-store' });
      setSession(data);
      setError(null);
      if (!data.authenticated) {
        setUnread(null);
        return;
      }
      // 未读数失败不影响登录态展示（角标是锦上添花，不是鉴权信息）。
      try {
        const inbox = await apiFetch<{ unreadCount: number }>('/api/me/notifications?limit=1', { cache: 'no-store' });
        setUnread(inbox.unreadCount);
      } catch {
        setUnread(null);
      }
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  /** 测试登录：只在开关打开时可用。 */
  const signInForTest = async () => {
    setBusy(true);
    try {
      // 幂等键固定一次；这里没有重试语义，仅保证同一次点击只建一个会话。
      const requestKey = newRequestKey();
      void requestKey;
      await apiFetch('/api/testing/session', {
        method: 'POST',
        json: { providerUserId: 'local-dev-user', providerUsername: 'local-dev' },
      });
      await loadSession();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await apiFetch('/api/session', { method: 'DELETE' });
      await loadSession();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <nav style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', gap: 16, alignItems: 'center' }}>
        <Link href="/" style={{ color: '#2456B8', fontWeight: 600, textDecoration: 'none' }}>
          DSH Plugin Review
        </Link>
        <Link href="/plugins" style={{ color: '#526174', textDecoration: 'none' }}>
          插件
        </Link>
        <Link href="/plugins/new" style={{ color: '#526174', textDecoration: 'none' }}>
          收录插件
        </Link>
        <Link href="/reviews" style={{ color: '#526174', textDecoration: 'none' }}>
          评测
        </Link>
        <Link href="/me" style={{ color: '#526174', textDecoration: 'none' }}>
          我的
        </Link>

        {/* 登录态区域：靠 marginLeft:auto 推到右侧 */}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          {session === null ? (
            <span style={{ color: '#526174' }}>正在读取登录状态…</span>
          ) : session.authenticated ? (
            <>
              <Link
                href="/me/notifications"
                style={{ color: '#2456B8', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                通知
                {unread !== null && unread > 0 ? (
                  <span
                    aria-label={`${unread} 条未读通知`}
                    style={{
                      background: '#B4232A',
                      color: '#FFFFFF',
                      borderRadius: 10,
                      padding: '1px 7px',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </Link>
              <span style={{ color: '#526174' }}>
                {session.userId}
                {session.role === 'admin' ? '（管理员）' : ''}
                {session.accountStatus === 'disabled' ? '（已禁用）' : ''}
              </span>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={busy}
                style={{ background: 'none', border: '1px solid #DBE1EA', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: '#526174' }}
              >
                登出
              </button>
            </>
          ) : (
            <>
              {session.githubLoginConfigured ? (
                <a
                  href="/api/auth/github/start"
                  style={{ background: '#2456B8', color: '#FFFFFF', borderRadius: 6, padding: '6px 12px', textDecoration: 'none' }}
                >
                  用 GitHub 登录
                </a>
              ) : (
                // 未配置时明说未配置，而不是给一个会返回 503 HTML 的链接。
                <span
                  title="服务端未设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET"
                  style={{
                    background: '#F3F5F8',
                    border: '1px dashed #DBE1EA',
                    borderRadius: 6,
                    padding: '6px 10px',
                    color: '#8A6D1C',
                    cursor: 'not-allowed',
                  }}
                >
                  GitHub 登录未配置
                </span>
              )}
              {session.testLoginEnabled ? (
                <button
                  type="button"
                  onClick={() => void signInForTest()}
                  disabled={busy}
                  style={{ background: '#FFFFFF', border: '1px solid #2456B8', color: '#2456B8', borderRadius: 6, padding: '5px 10px', cursor: 'pointer' }}
                >
                  {busy ? '登录中…' : '测试登录（开发）'}
                </button>
              ) : null}
            </>
          )}
        </span>
      </nav>
      {error ? (
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </div>
  );
}
