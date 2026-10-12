'use client';

/**
 * 评论框（任务 7 第 4 项）。
 *
 * 契约（见 src/app/api/content/[contentId]/comments/route.ts）：
 *   GET  /api/content/{contentId}/comments?page=&page_size=  → PageResult<CommentView>
 *   POST /api/content/{contentId}/comments  { body, requestKey, replyToCommentId? } → 202
 *
 * 几个真实约束（读代码得到，不是猜的）：
 *  - 接口只在**目标当前公开**时才返回/接受评论（否则 404 target_unavailable）；
 *  - `page_size` 只允许 10 / 20 / 50（PaginationDefaults.allowed_page_sizes）；
 *  - 新评论写入后处理状态是 `pending`，**尚未公开**，所以刚发完它可能不在公开列表里。
 *    这不是 bug，界面必须如实说明，不能让用户以为"发丢了"。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle, newRequestKey } from './api-client';

interface CommentView {
  commentId: string;
  authorId: string;
  body: string;
  replyToCommentId: string | null;
  rootCommentId: string | null;
  publishedRevisionId: string | null;
  createdAt: number;
  firstPublishedAt: number | null;
  deletedAt: number | null;
  replyCount: number;
}

interface PageResult<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_previous: boolean;
  has_next: boolean;
}

interface SessionData {
  authenticated: boolean;
  userId?: string;
  githubLoginConfigured: boolean;
  testLoginEnabled: boolean;
}

export function CommentSection({ contentId }: { contentId: string }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PageResult<CommentView> | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 一次提交一个幂等键；失败重试复用（否则重试会变成两条评论）。
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      setSession(await apiFetch<SessionData>('/api/session', { cache: 'no-store' }));
    } catch {
      // 会话读取失败不阻塞评论列表的展示（列表是公开的）。
      setSession(null);
    }
  }, []);

  const loadComments = useCallback(async () => {
    try {
      const result = await apiFetch<PageResult<CommentView>>(
        `/api/content/${encodeURIComponent(contentId)}/comments?page=${page}&page_size=20`,
        { cache: 'no-store' },
      );
      setData(result);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [contentId, page]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const requestKey = pendingKey ?? newRequestKey();
    setPendingKey(requestKey);

    try {
      await apiFetch(`/api/content/${encodeURIComponent(contentId)}/comments`, {
        method: 'POST',
        json: { body, requestKey },
      });
      setPendingKey(null);
      setBody('');
      setNotice('评论已提交，正在等待检查；通过后才会公开显示。');
      // 发完刷新列表（新评论此时通常还不在公开列表里，这一条由上面的提示解释）。
      await loadComments();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid #DBE1EA', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>评论（{data?.total ?? 0}）</h2>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: '#1E5B32', fontSize: 14 }}>{notice}</p> : null}

      {data === null ? (
        <p style={{ color: '#526174' }}>正在读取评论…</p>
      ) : data.items.length === 0 ? (
        <p style={{ color: '#526174' }}>还没有评论。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.items.map((c) => (
            <li key={c.commentId} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: '#526174' }}>
                {c.authorId}
                {c.firstPublishedAt === null ? ' · 尚未公开' : ` · ${new Date(c.firstPublishedAt).toLocaleString('zh-CN')}`}
                {c.replyCount > 0 ? ` · ${c.replyCount} 条回复` : ''}
              </div>
              <div>{c.deletedAt !== null ? '该评论已删除' : c.publishedRevisionId === null ? '该评论尚未公开' : c.body}</div>
            </li>
          ))}
        </ul>
      )}

      {data && data.total_pages > 1 ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <button
            type="button"
            disabled={!data.has_previous}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{ background: 'none', border: '1px solid #DBE1EA', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
          >
            上一页
          </button>
          <span style={{ fontSize: 14, color: '#526174' }}>
            第 {data.page} / {data.total_pages} 页
          </span>
          <button
            type="button"
            disabled={!data.has_next}
            onClick={() => setPage((p) => p + 1)}
            style={{ background: 'none', border: '1px solid #DBE1EA', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
          >
            下一页
          </button>
        </div>
      ) : null}

      {session === null ? (
        <p style={{ color: '#526174', fontSize: 14 }}>正在读取登录状态…</p>
      ) : session.authenticated ? (
        <form onSubmit={submit}>
          <label htmlFor={`comment-${contentId}`} style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            发表评论
          </label>
          <textarea
            id={`comment-${contentId}`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder="说点什么…"
            style={inputStyle}
            required
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="submit" disabled={busy || body.trim() === ''} style={buttonStyle}>
              {busy ? '提交中…' : pendingKey ? '重试提交' : '发表评论'}
            </button>
            <span style={{ color: '#526174', fontSize: 13 }}>提交后需通过检查才会公开显示。</span>
          </div>
        </form>
      ) : (
        <p style={{ color: '#526174', fontSize: 14 }}>
          登录后才能评论。
          {session.githubLoginConfigured ? (
            <>
              {' '}
              <a href="/api/auth/github/start" style={{ color: '#2456B8' }}>
                用 GitHub 登录
              </a>
            </>
          ) : (
            <> 当前站点未配置 GitHub 登录，请在顶部使用测试登录（开发环境）。</>
          )}
        </p>
      )}
    </section>
  );
}
