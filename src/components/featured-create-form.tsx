'use client';

/** 管理员：新建一期精选专栏（标题 + 主题 + 前言），成功后进编辑页。 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, newRequestKey } from './api-client';

export function FeaturedCreateForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [theme, setTheme] = useState('');
  const [preface, setPreface] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/featured', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, theme, prefaceMd: preface, requestKey: newRequestKey() }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { issueNumber?: number };
        error?: { message?: string };
      };
      if (!response.ok || !body.ok || typeof body.data?.issueNumber !== 'number') {
        throw { code: 'request_failed', message: body.error?.message ?? '创建失败。' } as ApiError;
      }
      router.push('/admin/featured/' + body.data.issueNumber + '/edit');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label style={{ fontSize: 13 }}>
        标题
        <input
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          style={{ width: '100%', display: 'block' }}
        />
      </label>
      <label style={{ fontSize: 13 }}>
        主题
        <input
          value={theme}
          maxLength={200}
          onChange={(e) => setTheme(e.target.value)}
          style={{ width: '100%', display: 'block' }}
        />
      </label>
      <label style={{ fontSize: 13 }}>
        前言（Markdown，可稍后补）
        <textarea
          value={preface}
          rows={4}
          onChange={(e) => setPreface(e.target.value)}
          style={{ width: '100%', display: 'block' }}
        />
      </label>
      <div>
        <button
          type="button"
          className="button primary"
          disabled={busy || title.trim() === '' || theme.trim() === ''}
          onClick={() => void submit()}
        >
          {busy ? '创建中…' : '创建并编辑'}
        </button>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
