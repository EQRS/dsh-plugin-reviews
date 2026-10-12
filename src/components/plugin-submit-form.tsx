'use client';

/**
 * 插件收录表单（任务 7 第 2 项）。
 *
 * `POST /api/plugins` 的契约（见 src/app/api/plugins/route.ts）：
 *   请求 `{ url: string, requestKey: string }`
 *   成功 → 该路由尚未返回 pluginId（当前实现一律抛 provider_not_configured）
 *
 * ⚠️ 已知真实情况：`POST /api/plugins` 目前**固定返回 `provider_not_configured`**
 * （GF 正在接入真实 GitHub 探针）。所以这里不假装成功、也不隐藏这条错误 ——
 * 把后端 message 原样展示，等探针接上后本表单无需改动即可工作。
 *
 * requestKey 语义：一次提交生成一个键；**失败后重试复用同一个键**，
 * 这样后端按幂等键判定时不会把重试当成新收录。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle, newRequestKey } from './api-client';

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
      const created = await apiFetch<AcceptedPlugin>('/api/plugins', {
        method: 'POST',
        json: { url, requestKey },
      });
      // 成功后清掉幂等键：下一次收录是不同的用户操作。
      setPendingKey(null);
      setNotice('收录成功，正在打开插件页…');
      if (created?.pluginId) router.push(`/plugins/${created.pluginId}`);
    } catch (e) {
      // 保留 pendingKey → 用户再点一次就是"重试同一请求"。
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <label htmlFor="repo-url" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
        GitHub 仓库链接
      </label>
      <input
        id="repo-url"
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/owner/repo 或带子目录路径"
        style={inputStyle}
        required
      />
      <p style={{ color: '#526174', fontSize: 13 }}>
        收录检查要求：仓库可访问、对应 <code>package.json</code> 声明了 <code>dsh.bundle</code>、且引用的配置文件存在。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: '#1E5B32' }}>{notice}</p> : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="submit" disabled={busy || url.trim() === ''} style={buttonStyle}>
          {busy ? '收录中…' : pendingKey ? '重试收录' : '提交收录'}
        </button>
        {pendingKey ? (
          <span style={{ color: '#8A6D1C', fontSize: 13 }}>
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
            style={{ background: 'none', border: 'none', color: '#2456B8', cursor: 'pointer', padding: 0 }}
          >
            重新开始
          </button>
        ) : null}
      </div>
    </form>
  );
}
