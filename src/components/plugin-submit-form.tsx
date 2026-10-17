'use client';

/**
 * 插件收录表单。
 *
 * 三态必须区分清楚：
 *   1. 未收录 → 检查通过后建条目，`created: true`；
 *   2. 已收录 → 命中既有条目，后端返回原插件 ID ——
 *      这时不能说"收录成功"（听起来像新建了一条），而要说"已在目录里，为你打开"；
 *   3. 检查未通过 → 后端给具体原因，就地展示、不建任何条目，改完链接可以重试。
 *
 * requestKey：一次提交生成一个键；失败后重试复用同一个键。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface AcceptedPlugin {
  pluginId: string;
  repositoryId: string;
  created: boolean;
  status: 'accepted';
}

export function PluginSubmitForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 失败重试必须复用同一个键：只在"没有待重试的键"时新建。
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const requestKey = pendingKey ?? newRequestKey();
    setPendingKey(requestKey);

    try {
      const accepted = await apiFetch<AcceptedPlugin>('/api/plugins', {
        method: 'POST',
        json: { url, requestKey },
      });
      // 成功后清掉幂等键：下一次收录是不同的用户操作。
      setPendingKey(null);
      // 三态措辞：created=false 是"命中既有条目"，不是"刚收录成功"。
      setNotice(
        accepted?.created === false
          ? '这个插件已经在目录里了，正在打开它的页面…'
          : '已提交收录，正在打开插件页…',
      );
      if (accepted?.pluginId) router.push(`/plugins/${accepted.pluginId}`);
    } catch (e) {
      // 保留 pendingKey → 用户再点一次就是"重试同一请求"。
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <label htmlFor="repo-url">
        GitHub 仓库链接
      </label>
      <input
        id="repo-url"
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/owner/repo 或带子目录路径"
        style={{ width: '100%' }}
        required
      />
      <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        检查要求：仓库可访问、<code>package.json</code> 声明了 <code>dsh.bundle</code>、且引用的配置文件存在。
        任一条不满足都会被拒绝，<strong>不会在目录里留下条目</strong>；已收录的再提交只会刷新资料。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p className="notice success">{notice}</p> : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="submit" disabled={busy || url.trim() === ''} className="button primary">
          {busy ? '提交中…' : pendingKey ? '重试提交' : '提交收录'}
        </button>
        {pendingKey ? (
          <span style={{ color: 'var(--warn-ink)', fontSize: 13 }}>
            重试会沿用同一个请求，不会产生第二条收录；要换链接请点"重新开始"。
          </span>
        ) : null}
        {pendingKey ? (
          <button
            type="button"
            onClick={() => {
              setPendingKey(null);
              setError(null);
            }}
            className="link-btn"
          >
            重新开始
          </button>
        ) : null}
      </div>
    </form>
  );
}
