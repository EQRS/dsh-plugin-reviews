'use client';

/**
 * 评论区（含组内回复）。
 *
 * 几个真实约束：
 *  - 新评论写入后处于待检查状态，尚未公开，所以刚发完它可能不在公开列表里；
 *    这不是 bug，界面必须如实说明，不能让用户以为"发丢了"；
 *  - 回复不随顶层列表返回，要单独取（懒加载，可继续翻页）。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, ErrorNotice, apiFetch, inputStyle, newRequestKey } from './api-client';
import { formatDateTime } from '@/packages/common/time';
import { SkeletonLines } from './skeleton';
import { ReportButton } from './report-button';

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

/** 展开状态：undefined = 没展开过；null = 正在读第一页；对象 = 已加载（items 为累计已取到的页）。 */
type ReplyState = { items: CommentView[]; total: number; page: number } | null;

/** 组内回复每页条数：后端只接受 10 / 20 / 50。 */
const REPLY_PAGE_SIZE = 50;

/** 单条评论的时间与署名行（顶层与回复共用，避免两处格式漂移）。 */
function CommentMeta({ comment }: { comment: CommentView }) {
  return (
    <div className="muted" style={{ fontSize: 13 }}>
      {comment.authorId}
      {comment.firstPublishedAt === null
        ? ' · 尚未公开'
        : ` · ${formatDateTime(comment.firstPublishedAt)}`}
      {/* 编辑过的评论要留痕（显示"已编辑"） */}
      {comment.editedAt !== null ? ` · 已编辑 ${formatDateTime(comment.editedAt)}` : ''}
    </div>
  );
}

function CommentBody({ comment }: { comment: CommentView }) {
  if (comment.deletedAt !== null) return <div className="muted">该评论已删除</div>;
  if (comment.publishedRevisionId === null) {
    return <div className="muted">该评论尚未公开</div>;
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
  /** 正在"加载更多"的讨论组 id（与首次加载区分：首次加载时整组显示"正在读取回复…"）。 */
  const [loadingMore, setLoadingMore] = useState<string | null>(null);

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

  /**
   * 懒加载某个顶层讨论组的回复。
   *
   * `page > 1` 表示"加载更多"：追加已取到的页，而不是替换
   * （替换会把用户刚看过的回复顶掉）。
   */
  const loadReplies = useCallback(
    async (rootCommentId: string, page = 1) => {
      if (page === 1) {
        setExpanded((prev) => ({ ...prev, [rootCommentId]: null }));
      } else {
        setLoadingMore(rootCommentId);
      }
      try {
        const result = await apiFetch<PageResult<CommentView>>(
          `/api/content/${encodeURIComponent(contentId)}/comments/${encodeURIComponent(rootCommentId)}/replies?page=${page}&page_size=${REPLY_PAGE_SIZE}`,
          { cache: 'no-store' },
        );
        setExpanded((prev) => {
          const already = page === 1 ? [] : (prev[rootCommentId]?.items ?? []);
          return {
            ...prev,
            [rootCommentId]: {
              items: [...already, ...result.items],
              total: result.total,
              page: result.page,
            },
          };
        });
      } catch (e) {
        // 第一页失败 = 整组打不开，退回未展开状态；
        // "加载更多"失败则保留已取到的内容，只把错误报出来。
        if (page === 1) {
          setExpanded((prev) => {
            const next = { ...prev };
            delete next[rootCommentId];
            return next;
          });
        }
        setError(e as ApiError);
      } finally {
        setLoadingMore(null);
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
    /* 讨论区做成一张卡片：正文是"平面散文"（不套面板），讨论区是卡片 —— 这是本项目一开始定的版式，
       主人反馈"评论这块太素"后，这里补齐卡片化与发表区的结构感。 */
    <section className="panel comment-section">
      <div className="section-head">
        <h2>评论（{data?.total ?? 0}）</h2>
      </div>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p className="muted" style={{ fontSize: 14 }}>{notice}</p> : null}

      {data === null ? (
        <SkeletonLines lines={3} label="正在读取评论…" />
      ) : data.items.length === 0 ? (
        <p className="muted">还没有评论。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.items.map((c) => {
            const group = expanded[c.commentId];
            const isOpen = group !== undefined;
            return (
              <li
                key={c.commentId}
                className="panel"
                style={{
                  marginBottom: 12,
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
                      <button type="button" disabled={busy} onClick={() => void saveEdit(c.commentId)} className="button primary">
                        保存修改
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditing(null);
                          setEditKey(null);
                        }}
                        className="button"
                        style={{ background: 'var(--surface-hover)', color: 'var(--ink)' }}
                      >
                        取消
                      </button>
                      <span className="muted" style={{ fontSize: 13 }}>保存后要过检查，通过才会替换公开内容。</span>
                    </div>
                  </div>
                ) : (
                  <CommentBody comment={c} />
                )}

                <div style={{ marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setReplyTo({ commentId: c.commentId, authorId: c.authorId })}
                    className="link-btn"
                  >
                    回复
                  </button>
                  {/* 举报（idea.md §20）：评论也能举报，结果进管理员队列 */}
                  <ReportButton
                    targetKind="comment"
                    targetId={c.commentId}
                    authenticated={session?.authenticated === true}
                  />
                  {/* 只有作者本人看得到编辑/删除；服务端还有一道 ownership 校验兜底 */}
                  {session?.authenticated && session.userId === c.authorId && c.deletedAt === null ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setEditing({ commentId: c.commentId, body: c.body })}
                        className="link-btn"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={busy && deletingId === c.commentId}
                        onClick={() => void removeComment(c.commentId)}
                        className="link-btn danger"
                      >
                        {deletingId === c.commentId ? '删除中…' : '删除'}
                      </button>
                    </>
                  ) : null}
                  {c.replyCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => toggleReplies(c.commentId)}
                      className="link-btn"
                    >
                      {isOpen ? '收起回复' : `查看 ${c.replyCount} 条回复`}
                    </button>
                  ) : null}
                </div>

                {isOpen ? (
                  group === null ? (
                    <p className="muted" style={{ fontSize: 13 }}>正在读取回复…</p>
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', borderLeft: '2px solid var(--line)' }}>
                      {group.items.map((r) => (
                        <li key={r.commentId} style={{ marginBottom: 8, paddingLeft: 10 }}>
                          <CommentMeta comment={r} />
                          <CommentBody comment={r} />
                          <div style={{ marginTop: 4 }}>
                            <ReportButton
                              targetKind="comment"
                              targetId={r.commentId}
                              authenticated={session?.authenticated === true}
                            />
                          </div>
                        </li>
                      ))}
                      {group.items.length < group.total ? (
                        <li style={{ paddingLeft: 10 }}>
                          <button
                            type="button"
                            className="link-btn"
                            disabled={loadingMore === c.commentId}
                            onClick={() => void loadReplies(c.commentId, group.page + 1)}
                          >
                            {loadingMore === c.commentId
                              ? '正在读取…'
                              : `加载更多回复（还有 ${group.total - group.items.length} 条）`}
                          </button>
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
        <div className="pagination" style={{ marginBottom: 12 }}>
          <button
            type="button"
            disabled={!data.has_previous}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="button"
          >
            上一页
          </button>
          <span className="muted" style={{ fontSize: 14 }}>
            第 {data.page} / {data.total_pages} 页
          </span>
          <button
            type="button"
            disabled={!data.has_next}
            onClick={() => setPage((p) => p + 1)}
            className="button"
          >
            下一页
          </button>
        </div>
      ) : null}

      {session === null ? (
        <p className="muted" style={{ fontSize: 14 }}>正在读取登录状态…</p>
      ) : session.authenticated ? (
        /* 发表区：一块内嵌容器（比卡片再高一级容器色），把"写评论"这个动作和列表分开 */
        <form onSubmit={submit} className="comment-composer">
          {replyTo ? (
            <div className="composer-reply">
              <span>正在回复这条评论</span>
              <button type="button" onClick={() => setReplyTo(null)} className="link-btn">
                取消
              </button>
            </div>
          ) : null}
          <label htmlFor={`comment-${contentId}`} className="composer-label">
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
          <div className="composer-actions">
            <button type="submit" disabled={busy || body.trim() === ''} className="button primary">
              {busy ? '提交中…' : pendingKey ? '重试提交' : replyTo ? '发表回复' : '发表评论'}
            </button>
            <span className="composer-hint">提交后需通过检查才会公开显示。</span>
          </div>
        </form>
      ) : (
        <p className="muted" style={{ fontSize: 14 }}>
          登录后才能评论。
          {session.githubLoginConfigured ? (
            <>
              {' '}
              <a href="/api/auth/github/start" style={{ color: 'var(--accent)' }}>
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
