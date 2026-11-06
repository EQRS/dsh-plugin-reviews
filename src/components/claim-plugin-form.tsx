'use client';

/**
 * 认领插件表单（「我的插件」页顶部）。
 *
 * 为什么要粘贴插件 ID 而不是给个下拉：站内插件数以百计，逐条列出既慢又与
 * 「找到自己的插件」这个动作错位——用户通常是从插件目录点进来的。
 * 这里要求填插件页地址或 ID，插件页那边再提供「这是我的」入口会更顺，
 * 那是下一步；当前先保证入口存在且能用。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, apiFetch } from './api-client';

/** 从插件页地址里抠出插件 id；直接填 id 也认。 */
function parsePluginId(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  // /plugins/{id} 或完整 URL 都以最后一段为准
  const m = t.match(/\/plugins\/([^/?#]+)/);
  return m ? m[1]! : t;
}

export function ClaimPluginForm() {
  const router = useRouter();
  const [raw, setRaw] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const pluginId = parsePluginId(raw);
    if (!pluginId) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<{ status: string; autoVerified: boolean }>(
        `/api/me/plugins/${encodeURIComponent(pluginId)}/claim`,
        { method: 'POST', json: { note: note.trim() } },
      );
      setDone(
        res.autoVerified
          ? '已通过 GitHub 账号匹配，插件已归到你名下。'
          : '认领已提交，等待管理员审核。',
      );
      setRaw('');
      setNote('');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-label="认领插件">
      <div className="section-head">
        <h2>认领插件</h2>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        粘贴插件页地址或插件 ID。你能对上该插件所在仓库的 GitHub 账号时会自动通过；
        仓库属于组织（或你是协作者）时需要说明情况，由管理员核实。
      </p>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: 8 }}>
        <input
          type="text"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="/plugins/xxxx 或插件 ID"
          aria-label="插件地址或 ID"
        />
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="补充说明（可选）：例如「我是该仓库的维护者」「仓库属于我所在的组织」"
          aria-label="认领说明"
        />
        <div>
          <button type="submit" className="button primary" disabled={busy || parsePluginId(raw) === ''}>
            {busy ? '提交中…' : '提交认领'}
          </button>
        </div>
      </form>
      {done ? (
        <p className="notice" style={{ marginBottom: 0 }}>
          {done}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </section>
  );
}
