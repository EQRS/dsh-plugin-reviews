'use client';

/**
 * 后台「业务设置」组（`idea.md §24`：常用参数后台可调 + 修改记录）。
 *
 * 只显示**真的被读取**的参数（定义来自服务端 `SETTING_DEFINITIONS`，前端不自己写一份清单 ——
 * 两份清单一定会漂移）。改完必须填原因，服务端会写一条配置修订。
 */

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle, newRequestKey } from './api-client';

interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  kind: 'integer' | 'boolean';
  defaultValue: number | boolean;
  min?: number;
  max?: number;
  unit?: string;
}

interface Revision {
  revisionId: string;
  revisionNumber: number;
  reason: string;
  changes: unknown;
  snapshot: Record<string, number | boolean>;
  changedByName: string | null;
  createdAt: number;
}

interface SettingsResponse {
  effective: Record<string, number | boolean>;
  definitions: SettingDefinition[];
  unknownKeys: string[];
  overriddenKeys: string[];
  history: Revision[];
}

type Draft = Record<string, string | boolean>;

export function AdminSettingsForm() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<SettingsResponse>('/api/admin/settings', { cache: 'no-store' });
      setData(result);
      setDraft(
        Object.fromEntries(
          result.definitions.map((d) => [d.key, String(result.effective[d.key] ?? d.defaultValue)]),
        ),
      );
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (data === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const changes: Record<string, unknown> = {};
      for (const def of data.definitions) {
        const raw = draft[def.key];
        if (def.kind === 'boolean') {
          const asBool = raw === true || raw === 'true';
          if (asBool !== (data.effective[def.key] === true)) changes[def.key] = asBool;
          continue;
        }
        const asNumber = Number(raw);
        if (!Number.isInteger(asNumber)) {
          // 本地先拦一道，免得白跑一次请求；服务端仍会再校验一次（不能只信前端）。
          setError(new ApiError({ code: 'input_invalid', message: `${def.label} 必须是整数。` }, 400));
          return;
        }
        if (asNumber !== data.effective[def.key]) changes[def.key] = asNumber;
      }
      if (Object.keys(changes).length === 0) {
        setNotice('没有改动（值与现状一致）；不会产生修订记录。');
        return;
      }
      const result = await apiFetch<{ revision_number: number | null; changed: unknown[] }>('/api/admin/settings', {
        method: 'PUT',
        json: { changes, reason, requestKey: newRequestKey() },
      });
      setNotice(`已生效，配置修订 #${result.revision_number ?? '?'}（${(result.changed as unknown[]).length} 项变更）。`);
      setReason('');
      await load();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid #DBE1EA', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>业务设置</h2>
      <p style={{ color: '#526174', fontSize: 14 }}>
        这里只列出**真的会被读取**的参数；改完留一条修订记录（含原因与完整生效快照）。
        媒体限额、草稿自动保存间隔等仍是模块内常量，尚未接入（见差距盘点）。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p style={{ color: '#1E5B32', fontSize: 14 }}>{notice}</p> : null}

      {data === null ? (
        <p style={{ color: '#526174' }}>正在读取配置…</p>
      ) : (
        <>
          {data.unknownKeys.length > 0 ? (
            <p style={{ color: '#8A6D1C', fontSize: 14 }}>
              注意：库里有 {data.unknownKeys.length} 个不在清单里的键（{data.unknownKeys.join('、')}
              ），它们不会生效，也不会被本页修改。
            </p>
          ) : null}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#526174' }}>
                <th style={{ padding: '6px 4px' }}>参数</th>
                <th style={{ padding: '6px 4px' }}>当前生效</th>
                <th style={{ padding: '6px 4px' }}>新值</th>
              </tr>
            </thead>
            <tbody>
              {data.definitions.map((def) => (
                <tr key={def.key} style={{ borderTop: '1px solid #DBE1EA', verticalAlign: 'top' }}>
                  <td style={{ padding: '8px 4px', maxWidth: 420 }}>
                    <div style={{ fontWeight: 600 }}>{def.label}</div>
                    <div style={{ color: '#526174' }}>{def.description}</div>
                    <div style={{ color: '#8A6D1C', fontSize: 13 }}>
                      默认 {String(def.defaultValue)}
                      {def.unit ?? ''}
                      {def.min !== undefined ? ` · 范围 ${def.min}–${def.max}` : ''} · {def.key}
                      {data.overriddenKeys.includes(def.key) ? ' · 已改过' : ''}
                    </div>
                  </td>
                  <td style={{ padding: '8px 4px' }}>
                    {String(data.effective[def.key])}
                    {def.unit ?? ''}
                  </td>
                  <td style={{ padding: '8px 4px' }}>
                    {def.kind === 'boolean' ? (
                      <select
                        aria-label={def.label}
                        value={draft[def.key] === true || draft[def.key] === 'true' ? 'true' : 'false'}
                        onChange={(e) => setDraft({ ...draft, [def.key]: e.target.value })}
                        style={inputStyle}
                      >
                        <option value="true">开</option>
                        <option value="false">关</option>
                      </select>
                    ) : (
                      <input
                        aria-label={def.label}
                        value={String(draft[def.key] ?? '')}
                        onChange={(e) => setDraft({ ...draft, [def.key]: e.target.value })}
                        style={{ ...inputStyle, width: 120 }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              aria-label="修改原因"
              placeholder="修改原因（必填，会进修订记录）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{ ...inputStyle, flex: '1 1 260px' }}
            />
            <button type="button" disabled={busy || reason.trim().length === 0} onClick={() => void save()} style={buttonStyle}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>

          <h3 style={{ fontSize: 16, marginTop: 24 }}>修改记录（最近 {data.history.length} 条）</h3>
          {data.history.length === 0 ? (
            <p style={{ color: '#526174', fontSize: 14 }}>还没有修改记录。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, fontSize: 14 }}>
              {data.history.map((r) => (
                <li key={r.revisionId} style={{ marginBottom: 8, color: '#526174' }}>
                  #{r.revisionNumber} · {formatDateTime(r.createdAt)} · {r.changedByName ?? '（未知）'} · {r.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
