'use client';

/**
 * 帖子操作条：点赞 / 编辑 / 删除 / 置顶。
 *
 * 按钮的显隐只是"不摆没用的入口"，权限判定仍在服务端（每个接口都自查）。
 * 删除是软删，所以确认文案要说清楚"会被标记为已删除"而不是"永久消失"。
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

export function ForumPostActions({
  postId,
  likedByMe,
  likeCount,
  canEdit,
  canDelete,
  canModerate,
  isPinned,
  authenticated,
  deleted,
}: {
  postId: string;
  likedByMe: boolean;
  likeCount: number;
  canEdit: boolean;
  canDelete: boolean;
  canModerate: boolean;
  isPinned: boolean;
  authenticated: boolean;
  deleted: boolean;
}) {
  const router = useRouter();
  const [liked, setLiked] = useState(likedByMe);
  const [count, setCount] = useState(likeCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleLike = async () => {
    if (!authenticated) {
      router.push('/onboarding?returnTo=' + encodeURIComponent(window.location.pathname));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ liked: boolean; count: number }>('/api/forum/posts/' + postId + '/like', {
        method: 'POST',
      });
      setLiked(result.liked);
      setCount(result.count);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/forum/posts/' + postId, { method: 'DELETE' });
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const togglePin = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/forum/posts/' + postId + '/pin', { method: 'POST', json: { pinned: !isPinned } });
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className={liked ? 'button tonal' : 'button'}
          onClick={() => void toggleLike()}
          disabled={busy || deleted}
        >
          {liked ? '已赞' : '赞'} {count}
        </button>

        {canEdit && !deleted ? (
          <Link href={'/forum/edit/' + postId} className="link-btn">
            编辑
          </Link>
        ) : null}

        {canModerate ? (
          <button type="button" className="link-btn muted" onClick={() => void togglePin()} disabled={busy}>
            {isPinned ? '取消置顶' : '置顶'}
          </button>
        ) : null}

        {canDelete && !deleted ? (
          confirmDelete ? (
            <>
              <span className="muted" style={{ fontSize: 13 }}>
                删除后帖子会显示「已删除」，回复与点赞记录仍保留。确认？
              </span>
              <button type="button" className="link-btn" onClick={() => void remove()} disabled={busy}>
                确认删除
              </button>
              <button type="button" className="link-btn muted" onClick={() => setConfirmDelete(false)} disabled={busy}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="link-btn muted" onClick={() => setConfirmDelete(true)} disabled={busy}>
              删除
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
