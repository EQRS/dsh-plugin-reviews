'use client';

/**
 * 插件收录表单（任务 7 第 2 项）。
 *
 * `POST /api/plugins` 的契约（见 src/app/api/plugins/route.ts）：
 *   请求 `{ url: string, requestKey: string }`
 *   成功 → `{ pluginId, repositoryId, created, status: 'accepted' }`
 *
 * **三态必须区分清楚**（这是这个表单唯一的难点）：
 *   1. 未收录 → 检查通过后建条目，`created: true`；
 *   2. **已收录** → 命中既有条目，`created: false`，后端返回**原插件 ID** ——
 *      这时不能说"收录成功"（听起来像新建了一条），而要说"已在目录里，为你打开"；
 *   3. 检查未通过 → 后端给具体原因（仓库不存在 / 没声明 dsh.bundle / 配置文件不存在），
 *      就地展示、**不建任何条目**，用户改完链接可以重试。
 *
 * requestKey 语义：一次提交生成一个键；**失败后重试复用同一个键**，
 * 这样后端按幂等键判定时不会把重试当成新收录。
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
          : '收录成功，正在打开插件页…',
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
      <p className="muted" style={{ fontSize: 13 }}>
        收录检查要求：仓库可访问、对应 <code>package.json</code> 声明了 <code>dsh.bundle</code>、且引用的配置文件存在。
        任一条不满足都会被拒绝，**不会在目录里留下条目**；已经在目录里的插件再提交一次，
        只会刷新它的资料，不会产生第二条。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p className="notice success">{notice}</p> : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="submit" disabled={busy || url.trim() === ''} className="button primary">
          {busy ? '收录中…' : pendingKey ? '重试收录' : '提交收录'}
        </button>
        {pendingKey ? (
          <span style={{ color: 'var(--warn-ink)', fontSize: 13 }}>
            重试将复用同一个请求标识；如要换一个链接，请点"重新开始"。
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
