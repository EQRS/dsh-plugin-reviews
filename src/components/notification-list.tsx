'use client';

/**
 * 通知收件箱（`idea.md §11`）。
 *
 * 全部来自 `GET /api/me/notifications`：列表 + 未读数。
 * 「全部标为已读」走 `POST /api/me/notifications/read`（幂等，所以不要请求键）。
 * 不做"点开某条跳到评论"的深链接 —— 本切片的内容页锚点还没有稳定约定，
 * 与其做一个跳不准的按钮，不如先把列表与已读做对。
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

interface NotificationItem {
  id: string;
  kind: 'comment_on_content' | 'reply_to_comment';
  commentId: string;
  contentEntityId: string;
  actorNickname: string;
  actorAvatarUrl: string | null;
  excerpt: string;
  readAt: number | null;
  createdAt: number;
}

interface Inbox {
  items: NotificationItem[];
  unreadCount: number;
}

export function NotificationList() {
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<Inbox>(
        `/api/me/notifications?limit=50${onlyUnread ? '&unread_only=1' : ''}`,
        { cache: 'no-store' },
      );
      setData(result);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, [onlyUnread]);

  useEffect(() => {
    void load();
  }, [load]);

  const markAllRead = async () => {
    setBusy(true);
    try {
      await apiFetch('/api/me/notifications/read', { method: 'POST', json: { all: true } });
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const markOne = async (id: string) => {
    setBusy(true);
    try {
      await apiFetch('/api/me/notifications/read', { method: 'POST', json: { ids: [id] } });
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      {/* 工具栏：左侧是状态与筛选，右侧是批量操作（都在同一条 section-head 上，不再把按钮甩到最右边） */}
      <div className="section-head" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {data !== null ? (
            <span className={data.unreadCount > 0 ? 'tag site' : 'tag'}>未读 {data.unreadCount}</span>
          ) : null}
          <label
            className="muted"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, marginBottom: 0, fontWeight: 400 }}
          >
            <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
            只看未读
          </label>
        </div>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={busy || data === null || data.unreadCount === 0}
          className="button"
        >
          全部标为已读
        </button>
      </div>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {data === null ? (
        <p className="muted" style={{ marginBottom: 0 }}>正在读取通知…</p>
      ) : data.items.length === 0 ? (
        <p className="empty" style={{ marginBottom: 0 }}>
          {onlyUnread
            ? '没有未读通知。'
            : '还没有通知。别人评论你的评测、或回复你的评论时，会出现在这里。'}
        </p>
      ) : (
        <ul className="item-list">
          {data.items.map((n) => (
            <li
              key={n.id}
              /* 未读=强调色左边框 + 淡底；已读=静默态（设计系统的 .notice.quiet） */
              className={n.readAt === null ? 'notice' : 'notice quiet'}
              style={{ marginBottom: 10 }}
            >
              <div style={{ fontSize: 14 }}>
                <strong>{n.actorNickname}</strong>
                {n.kind === 'reply_to_comment' ? ' 回复了你的评论' : ' 评论了你的内容'}
                <span className="muted">
                  {' · '}
                  {formatDateTime(n.createdAt)}
                  {n.readAt === null ? '' : '（已读）'}
                </span>
              </div>
              <div style={{ marginTop: 6, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{n.excerpt}</div>
              <div style={{ marginTop: 6, display: 'flex', gap: 12, alignItems: 'center' }}>
                <Link href={`/reviews/${n.contentEntityId}`} className="link-btn">
                  去看这条内容
                </Link>
                {n.readAt === null ? (
                  <button type="button" disabled={busy} onClick={() => void markOne(n.id)} className="link-btn muted">
                    标为已读
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
