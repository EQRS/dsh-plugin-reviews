'use client';

/**
 * 资料确认表单（`/onboarding` 用）。
 *
 * 契约：PATCH /api/me/profile { nickname } → { nickname }
 *
 * 说明：
 *  - 昵称是本站**唯一**的展示身份（文章署名、评论署名都用它），所以新用户落地时先确认一次；
 *  - 昵称可留空提交吗？不行 —— 库里 `users.nickname` 有 `trim(nickname) <> ''` 约束，
 *    后端也会拒。这里就地拦住，省一趟往返；
 *  - 「跳过」不是错误路径：不填也能进站，之后可以再来改。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

export function ProfileForm({ initialNickname, returnTo }: { initialNickname: string; returnTo: string }) {
  const router = useRouter();
  const [nickname, setNickname] = useState(initialNickname);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // 一次保存一个幂等键；失败重试复用（否则重试会变成两次写）。
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (nickname.trim() === '') {
      setError(new ApiError({ code: 'input_invalid', message: '昵称不能为空。' }, 400));
      return;
    }

    setBusy(true);
    setError(null);
    const requestKey = pendingKey ?? newRequestKey();
    setPendingKey(requestKey);

    try {
      await apiFetch<{ nickname: string }>('/api/me/profile', {
        method: 'PATCH',
        json: { nickname: nickname.trim() },
      });
      setPendingKey(null);
      router.push(returnTo);
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} style={{ marginTop: 12 }}>
      <label htmlFor="nickname">
        展示昵称
      </label>
      <input
        id="nickname"
        type="text"
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        placeholder="例如：阿猫"
        style={{ width: '100%' }}
      />
      <p className="muted" style={{ fontSize: 13 }}>
        这是你在这里唯一的公开身份：评测与评论的署名都用它。之后可以在「我的」页面再改。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button type="submit" disabled={busy} className="button primary">
          {busy ? '保存中…' : '保存并进入网站'}
        </button>
        <a href={returnTo} style={{ fontSize: 14 }}>
          跳过，直接进入
        </a>
      </div>
    </form>
  );
}
