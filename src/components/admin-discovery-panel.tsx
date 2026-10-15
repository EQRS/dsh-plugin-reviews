'use client';

/**
 * 后台「任务与同步」组（`idea.md §1`：管理员的"立即同步"按钮）。
 *
 * 展示最近几轮自动发现的结果 —— 读的是任务的 `progress` 列（每轮结束由 worker 写入），
 * 以及"这一轮为什么只有这么几条"（配额/配置谁在限制）。
 */

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@/packages/common/time';
import { ApiError, ErrorNotice, apiFetch, newRequestKey } from './api-client';

interface RunSummary {
  runKey?: string;
  query?: string;
  searchedRepos?: number;
  pluginsFound?: number;
  accepted?: number;
  created?: number;
  refreshed?: number;
  requestsUsed?: number;
  truncated?: boolean;
  truncatedReason?: string | null;
  skipped?: Array<{ url: string; code: string; reason: string }>;
}

interface DiscoveryRun {
  taskId: string;
  deduplicationKey: string;
  state: string;
  attempts: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  summary: RunSummary | null;
  createdAt: number;
  finishedAt: number | null;
}

interface DiscoveryResponse {
  runs: DiscoveryRun[];
  config: {
    dailyEnabled: boolean;
    maxPluginsPerRun: number;
    effectiveMaxPlugins: number;
    authenticated: boolean;
    maxRequests: number;
    query: string;
  };
  settingsUnknownKeys: string[];
}

export function AdminDiscoveryPanel() {
  const [data, setData] = useState<DiscoveryResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maxPlugins, setMaxPlugins] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<DiscoveryResponse>('/api/admin/discovery', { cache: 'no-store' }));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const parsed = maxPlugins.trim() === '' ? undefined : Number(maxPlugins);
      if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1 || parsed > 200)) {
        setError(new ApiError({ code: 'input_invalid', message: '每轮上限必须是 1..200 的整数。' }, 400));
        return;
      }
      const result = await apiFetch<{ taskId: string; created: boolean; maxPlugins: number }>(
        '/api/admin/discovery',
        { method: 'POST', json: { requestKey: newRequestKey(), maxPlugins: parsed } },
      );
      setNotice(
        `已排入发现任务 ${result.taskId.slice(-8)}（每轮最多收录 ${result.maxPlugins} 个）。worker 通常几秒内领走，完成后这里会显示结果。`,
      );
      // 稍等一下再刷，让 worker 有机会领走并跑完（跑一轮通常十几秒）。
      setTimeout(() => void load(), 8000);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginTop: 32, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <h2 style={{ fontSize: 18 }}>任务与同步</h2>
      <p className="muted">
        每天一轮自动发现（按天幂等、重启自愈）；这里可以立即排一轮，与定时那一轮走**完全同一条路径**。
      </p>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <p className="notice success">{notice}</p> : null}

      {data === null ? (
        <p className="muted">正在读取发现任务…</p>
      ) : (
        <>
          <div className="muted">
            搜索词 <code>{data.config.query}</code> · 每日开关{' '}
            <strong>{data.config.dailyEnabled ? '开' : '关'}</strong> · 上游客源{' '}
            <strong>{data.config.authenticated ? '已认证（额度高）' : '未认证（核心接口 60 次/小时）'}</strong> ·
            本轮最多收录 <strong>{data.config.effectiveMaxPlugins}</strong> 个（配置 {data.config.maxPluginsPerRun}、请求上限{' '}
            {data.config.maxRequests}）
          </div>

          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              aria-label="本轮最多收录"
              placeholder="本轮最多收录（留空用配置值）"
              value={maxPlugins}
              onChange={(e) => setMaxPlugins(e.target.value)}
              style={{ width: 260 }}
            />
            <button type="button" disabled={busy} onClick={() => void runNow()} className="button primary">
              {busy ? '排入中…' : '立即发现'}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="button"
            >
              刷新
            </button>
          </div>

          <h3 style={{ fontSize: 16, marginTop: 20 }}>最近几轮</h3>
          {data.runs.length === 0 ? (
            <p className="muted">还没有跑过。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {data.runs.map((run) => (
                <li
                  key={run.taskId}
                  className="panel"
                  style={{ padding: 12, marginBottom: 10, fontSize: 14 }}
                >
                  <div>
                    <strong>{run.deduplicationKey}</strong>
                    <span className="muted">
                      {' · '}
                      {run.state}
                      {run.finishedAt !== null ? ` · ${formatDateTime(run.finishedAt)}` : ' · 进行中'}
                      {run.attempts > 1 ? ` · 尝试 ${run.attempts} 次` : ''}
                    </span>
                  </div>
                  {run.summary ? (
                    <div className="muted" style={{ marginTop: 4 }}>
                      搜到 {run.summary.searchedRepos ?? 0} 个候选 · 找到 {run.summary.pluginsFound ?? 0} 个插件 ·{' '}
                      收录 {run.summary.accepted ?? 0}（新建 {run.summary.created ?? 0} / 刷新{' '}
                      {run.summary.refreshed ?? 0}） · 上游请求 {run.summary.requestsUsed ?? 0} 次
                      {run.summary.truncated ? ` · 提前收尾：${run.summary.truncatedReason ?? '未说明'}` : ''}
                    </div>
                  ) : (
                    <div className="muted" style={{ marginTop: 4 }}>（还没有结果）</div>
                  )}
                  {run.lastErrorSummary ? (
                    <div style={{ color: 'var(--danger)', marginTop: 4 }}>
                      错误 {run.lastErrorCode}：{run.lastErrorSummary}
                    </div>
                  ) : null}
                  {run.summary?.skipped && run.summary.skipped.length > 0 ? (
                    <details className="muted" style={{ marginTop: 6 }}>
                      <summary style={{ cursor: 'pointer' }}>跳过的 {run.summary.skipped.length} 条（含原因）</summary>
                      <ul style={{ marginTop: 6 }}>
                        {run.summary.skipped.map((s, i) => (
                          <li key={`${s.url}-${i}`}>
                            <code>{s.code}</code> {s.url} —— {s.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
