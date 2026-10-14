'use client';

/**
 * 评论区（任务 7 第 4 项；回复功能为第三轮补全）。
 *
 * 契约（见 src/app/api/content/[contentId]/comments/route.ts 与 .../[commentId]/replies/route.ts）：
 *   GET  /api/content/{contentId}/comments?page=&page_size=            → PageResult<CommentView>（仅顶层）
 *   GET  /api/content/{contentId}/comments/{commentId}/replies?...     → PageResult<CommentView>（组内回复）
 *   POST /api/content/{contentId}/comments  { body, requestKey, replyToCommentId? } → 202
 *
 * 几个真实约束（读代码得到，不是猜的）：
 *  - 接口只在**目标当前公开**时才返回/接受评论（否则 404 target_unavailable）；
 *  - `page_size` 只允许 10 / 20 / 50（PaginationDefaults.allowed_page_sizes）；
 *  - 新评论写入后处理状态是 `pending`，**尚未公开**，所以刚发完它可能不在公开列表里。
 *    这不是 bug，界面必须如实说明，不能让用户以为"发丢了"；
 *  - 回复**不随顶层列表返回**，要单独取（懒加载）—— 顶层列表里只有 `replyCount` 这个数字。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle, newRequestKey } from './api-client';
import { formatDateTime } from '@/packages/common/time';

interface CommentView {
  commentId: string;
  authorId: string;
  body: string;
  replyToCommentId: string | null;
  rootCommentId: string | null;
  publishedRevisionId: string | null;
  createdAt: number;
  firstPublishedAt: number | null;
  /** 被编辑并**发布**过的时间（空 = 没改过）；页面据此显示"已编辑"。 */
  editedAt: number | null;
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
  githubLoginEnabled?: boolean;
  githubLoginConfigured: boolean;
  testLoginEnabled: boolean;
}

/** 展开状态：undefined = 没展开过；null = 加载中；对象 = 已加载。 */
type ReplyState = { items: CommentView[]; total: number } | null;

/** 单条评论的时间与署名行（顶层与回复共用，避免两处格式漂移）。 */
function CommentMeta({ comment }: { comment: CommentView }) {
  return (
    <div style={{ fontSize: 13, color: '#526174' }}>
      {comment.authorId}
      {comment.firstPublishedAt === null
        ? ' · 尚未公开'
        : ` · ${formatDateTime(comment.firstPublishedAt)}`}
      {/* 编辑过的评论要留痕（`idea.md §11`：替换后显示"已编辑"） */}
      {comment.editedAt !== null ? ` · 已编辑 ${formatDateTime(comment.editedAt)}` : ''}
    </div>
  );
}

function CommentBody({ comment }: { comment: CommentView }) {
  if (comment.deletedAt !== null) return <div style={{ color: '#526174' }}>该评论已删除</div>;
  if (comment.publishedRevisionId === null) {
    return <div style={{ color: '#526174' }}>该评论尚未公开</div>;
  }
  return <div style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</div>;
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

  // 回复相关
  const [expanded, setExpanded] = useState<Record<string, ReplyState>>({});
  const [replyTo, setReplyTo] = useState<{ commentId: string; authorId: string } | null>(null);

  // 编辑相关：一次只编辑一条（同时开两个编辑框只会让人改错）
  const [editing, setEditing] = useState<{ commentId: string; body: string } | null>(null);
  // 编辑也用幂等键：失败重试复用，免得重试变成两个修订（同新建评论的道理）
  const [editKey, setEditKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  /** 懒加载某个顶层讨论组的回复。 */
  const loadReplies = useCallback(
    async (rootCommentId: string) => {
      setExpanded((prev) => ({ ...prev, [rootCommentId]: null }));
      try {
        const result = await apiFetch<PageResult<CommentView>>(
          `/api/content/${encodeURIComponent(contentId)}/comments/${encodeURIComponent(rootCommentId)}/replies?page=1&page_size=50`,
          { cache: 'no-store' },
        );
        setExpanded((prev) => ({ ...prev, [rootCommentId]: { items: result.items, total: result.total } }));
      } catch (e) {
        setExpanded((prev) => {
          const next = { ...prev };
          delete next[rootCommentId];
          return next;
        });
        setError(e as ApiError);
      }
    },
    [contentId],
  );

  const toggleReplies = (rootCommentId: string) => {
    if (expanded[rootCommentId] !== undefined) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[rootCommentId];
        return next;
      });
      return;
    }
    void loadReplies(rootCommentId);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const requestKey = pendingKey ?? newRequestKey();
    setPendingKey(requestKey);
    const targetRoot = replyTo?.commentId ?? null;

    try {
      await apiFetch(`/api/content/${encodeURIComponent(contentId)}/comments`, {
        method: 'POST',
        json: { body, requestKey, replyToCommentId: targetRoot },
      });
      setPendingKey(null);
      setBody('');
      setReplyTo(null);
      setNotice(
        targetRoot === null
          ? '评论已提交，正在等待检查；通过后才会公开显示。'
          : '回复已提交，正在等待检查；通过后才会在讨论组里显示。',
      );
      // 发完刷新列表（新评论此时通常还不在公开列表里，这一条由上面的提示解释）。
      await loadComments();
      if (targetRoot !== null && expanded[targetRoot] !== undefined) {
        await loadReplies(targetRoot);
      }
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /** 保存编辑：走 PUT（同套检查，通过后才替换公开内容）。 */
  const saveEdit = async (commentId: string) => {
    if (editing === null) return;
    setBusy(true);
    setError(null);
    const requestKey = editKey ?? newRequestKey();
    setEditKey(requestKey);
    try {
      await apiFetch(
        `/api/content/${encodeURIComponent(contentId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'PUT', json: { body: editing.body, requestKey } },
      );
      setEditKey(null);
      setEditing(null);
      setNotice('修改已提交，正在等待检查；通过后才会替换公开内容。');
      await loadComments();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  /** 删除自己的评论（软删除；有回复时保留占位）。 */
  const removeComment = async (commentId: string) => {
    setBusy(true);
    setError(null);
    setDeletingId(commentId);
    try {
      const result = await apiFetch<{ deleted: boolean; alreadyDeleted: boolean; hasReplies: boolean }>(
        `/api/content/${encodeURIComponent(contentId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'DELETE' },
      );
      setNotice(
        result.alreadyDeleted
          ? '这条评论已经删过了。'
          : result.hasReplies
            ? '评论已删除；因为下面还有回复，这里会留一个占位。'
            : '评论已删除。',
      );
      await loadComments();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setDeletingId(null);
      setBusy(false);
    }
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid #DBE1EA', paddingTop: 16 }}>      <h2 style={{ fontSize: 18 }}>评论（{data?.total ?? 0}）</h2>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: '#1E5B32', fontSize: 14 }}>{notice}</p> : null}

      {data === null ? (
        <p style={{ color: '#526174' }}>正在读取评论…</p>
      ) : data.items.length === 0 ? (
        <p style={{ color: '#526174' }}>还没有评论。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.items.map((c) => {
            const group = expanded[c.commentId];
            const isOpen = group !== undefined;
            return (
              <li
                key={c.commentId}
                style={{
                  marginBottom: 12,
                  background: '#FFFFFF',
                  border: '1px solid #DBE1EA',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <CommentMeta comment={c} />
                {editing?.commentId === c.commentId ? (
                  <div style={{ marginTop: 6 }}>
                    <textarea
                      value={editing.body}
                      onChange={(e) => setEditing({ commentId: c.commentId, body: e.target.value })}
                      rows={4}
                      aria-label="编辑评论正文"
                      style={{ ...inputStyle, width: '100%' }}
                    />
                    <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                      <button type="button" disabled={busy} onClick={() => void saveEdit(c.commentId)} style={buttonStyle}>
                        保存修改
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditing(null);
                          setEditKey(null);
                        }}
                        style={{ ...buttonStyle, background: '#526174' }}
                      >
                        取消
                      </button>
                      <span style={{ fontSize: 13, color: '#526174' }}>保存后要过检查，通过才会替换公开内容。</span>
                    </div>
                  </div>
                ) : (
                  <CommentBody comment={c} />
                )}

                <div style={{ marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setReplyTo({ commentId: c.commentId, authorId: c.authorId })}
                    style={{ background: 'none', border: 'none', color: '#2456B8', cursor: 'pointer', padding: 0, fontSize: 13 }}
                  >
                    回复
                  </button>
                  {/* 只有作者本人看得到编辑/删除；服务端还有一道 ownership 校验兜底 */}
                  {session?.authenticated && session.userId === c.authorId && c.deletedAt === null ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditing({ commentId: c.commentId, body: c.body })}
                        style={{ background: 'none', border: 'none', color: '#2456B8', cursor: 'pointer', padding: 0, fontSize: 13 }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={busy && deletingId === c.commentId}
                        onClick={() => void removeComment(c.commentId)}
                        style={{ background: 'none', border: 'none', color: '#B4232A', cursor: 'pointer', padding: 0, fontSize: 13 }}
                      >
                        {deletingId === c.commentId ? '删除中…' : '删除'}
                      </button>
                    </>
                  ) : null}
                  {c.replyCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => toggleReplies(c.commentId)}
                      style={{ background: 'none', border: 'none', color: '#2456B8', cursor: 'pointer', padding: 0, fontSize: 13 }}
                    >
                      {isOpen ? '收起回复' : `查看 ${c.replyCount} 条回复`}
                    </button>
                  ) : null}
                </div>

                {isOpen ? (
                  group === null ? (
                    <p style={{ color: '#526174', fontSize: 13 }}>正在读取回复…</p>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', borderLeft: '2px solid #DBE1EA' }}>
                      {group.items.map((r) => (
                        <li key={r.commentId} style={{ marginBottom: 8, paddingLeft: 10 }}>
                          <CommentMeta comment={r} />
                          <CommentBody comment={r} />
                        </li>
                      ))}
                      {group.total > group.items.length ? (
                        <li style={{ paddingLeft: 10, fontSize: 13, color: '#526174' }}>
                          （还有 {group.total - group.items.length} 条回复未显示）
                        </li>
                      ) : null}
                    </ul>
                  )
                ) : null}
              </li>
            );
          })}
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
          {replyTo ? (
            <div
              style={{
                background: '#EEF3FF',
                border: '1px solid #C6D6F5',
                borderRadius: 6,
                padding: '6px 10px',
                fontSize: 13,
                marginBottom: 6,
              }}
            >
              正在回复 <code>{replyTo.authorId}</code>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                style={{ marginLeft: 8, background: 'none', border: 'none', color: '#2456B8', cursor: 'pointer', padding: 0 }}
              >
                取消
              </button>
            </div>
          ) : null}
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
              {busy ? '提交中…' : pendingKey ? '重试提交' : replyTo ? '发表回复' : '发表评论'}
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
