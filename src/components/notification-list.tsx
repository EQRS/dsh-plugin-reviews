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
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>通知</h1>
        {data !== null ? <span style={{ color: '#526174' }}>未读 {data.unreadCount} 条</span> : null}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#526174', fontSize: 14 }}>
          <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
          只看未读
        </label>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={busy || data === null || data.unreadCount === 0}
          style={{
            marginLeft: 'auto',
            background: '#FFFFFF',
            border: '1px solid #2456B8',
            color: '#2456B8',
            borderRadius: 6,
            padding: '6px 12px',
            cursor: 'pointer',
          }}
        >
          全部标为已读
        </button>
      </div>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {data === null ? (
        <p style={{ color: '#526174' }}>正在读取通知…</p>
      ) : data.items.length === 0 ? (
        <p style={{ color: '#526174' }}>{onlyUnread ? '没有未读通知。' : '还没有通知。'}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.items.map((n) => (
            <li
              key={n.id}
              style={{
                background: n.readAt === null ? '#FFFFFF' : '#F3F5F8',
                border: '1px solid #DBE1EA',
                borderLeft: n.readAt === null ? '3px solid #2456B8' : '3px solid #DBE1EA',
                borderRadius: 8,
                padding: 12,
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 14 }}>
                <strong>{n.actorNickname}</strong>
                {n.kind === 'reply_to_comment' ? ' 回复了你的评论' : ' 评论了你的内容'}
                <span style={{ color: '#526174' }}>
                  {' · '}
                  {formatDateTime(n.createdAt)}
                  {n.readAt === null ? '' : '（已读）'}
                </span>
              </div>
              <div style={{ marginTop: 6, color: '#1E293B', whiteSpace: 'pre-wrap' }}>{n.excerpt}</div>
              <div style={{ marginTop: 6, display: 'flex', gap: 12 }}>
                <Link
                  href={`/reviews/${n.contentEntityId}`}
                  style={{ color: '#2456B8', fontSize: 13, textDecoration: 'none' }}
                >
                  去看这条内容
                </Link>
                {n.readAt === null ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void markOne(n.id)}
                    style={{ background: 'none', border: 'none', color: '#526174', cursor: 'pointer', padding: 0, fontSize: 13 }}
                  >
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
