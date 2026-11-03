'use client';

/**
 * 精选专栏编辑器（管理员）。
 *
 * 三个刻意的决定：
 *  1. **整份清单保存**：换位与逐项文案一起 PATCH，服务端按 expectedVersion 乐观锁；
 *     逐条保存会留下「顺序变了、文案没变」的中间态。
 *  2. **顺序与内容绑定**：items 是带 pluginId 的对象数组，上移/下移只挪数组元素，
 *     文案永远跟着自己的插件走（不按位置存文案）。
 *  3. **评分是 0–100 整数**：输入框用字符串存草稿值，保存时统一校验，避免「清空输入框」变成 NaN。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, SuccessNotice } from './api-client';
import { DEFAULT_AUTOSAVE_SECONDS } from '@/packages/common/autosave';

export interface EditorItem {
  pluginId: string;
  label: string;
  repositoryFullName: string;
  pluginPath: string;
  avatarUrl: string | null;
  summary: string;
  reason: string;
  /** 输入框里的原始字符串；保存前校验为 0–100 整数。 */
  score: string;
  detailUrl: string;
  recommendedVersion: string;
}

export interface EditorInitial {
  issueNumber: number;
  title: string;
  theme: string;
  prefaceMarkdown: string;
  status: 'draft' | 'published';
  stateVersion: number;
  items: Array<{
    pluginId: string;
    summary: string;
    reason: string;
    score: number;
    detailUrl: string | null;
    recommendedVersion: string | null;
    plugin: {
      displayName: string | null;
      pluginPath: string;
      repositoryFullName: string;
      ownerAvatarUrl: string | null;
    };
  }>;
}

interface PickItem {
  pluginId: string;
  label: string;
  repositoryFullName: string;
  pluginPath: string;
  avatarUrl: string | null;
}

function toEditorItem(item: EditorInitial['items'][number]): EditorItem {
  return {
    pluginId: item.pluginId,
    label: item.plugin.displayName ?? item.plugin.repositoryFullName,
    repositoryFullName: item.plugin.repositoryFullName,
    pluginPath: item.plugin.pluginPath,
    avatarUrl: item.plugin.ownerAvatarUrl,
    summary: item.summary,
    reason: item.reason,
    score: String(item.score),
    detailUrl: item.detailUrl ?? '',
    recommendedVersion: item.recommendedVersion ?? '',
  };
}

export function FeaturedEditor({
  initial,
  initialAutosaveSeconds = DEFAULT_AUTOSAVE_SECONDS,
}: {
  initial: EditorInitial;
  initialAutosaveSeconds?: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [theme, setTheme] = useState(initial.theme);
  const [preface, setPreface] = useState(initial.prefaceMarkdown);
  const [items, setItems] = useState<EditorItem[]>(initial.items.map(toEditorItem));
  const [version, setVersion] = useState(initial.stateVersion);
  const [status, setStatus] = useState(initial.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState<'none' | 'favorites' | 'search'>('none');
  const [favorites, setFavorites] = useState<PickItem[] | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PickItem[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  const markDirty = () => {
    setDirty(true);
    setNotice(null);
  };

  const payload = useCallback(
    () => ({
      title,
      theme,
      prefaceMd: preface,
      expectedVersion: version,
      items: items.map((item) => ({
        pluginId: item.pluginId,
        summary: item.summary,
        reason: item.reason,
        score: Number.parseInt(item.score, 10),
        detailUrl: item.detailUrl.trim() === '' ? null : item.detailUrl.trim(),
        recommendedVersion: item.recommendedVersion.trim() === '' ? null : item.recommendedVersion.trim(),
      })),
    }),
    [title, theme, preface, version, items],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/featured/' + initial.issueNumber, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: { stateVersion?: number };
        error?: { message?: string };
      };
      if (!response.ok || !body.ok) {
        throw { code: 'request_failed', message: body.error?.message ?? '保存失败。' } as ApiError;
      }
      if (typeof body.data?.stateVersion === 'number') setVersion(body.data.stateVersion);
      setDirty(false);
      setNotice('已保存');
      return true;
    } catch (e) {
      setError(e as ApiError);
      return false;
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }, [initial.issueNumber, payload]);

  // 停止输入 N 秒自动保存（与评测/整合包编辑页同一套口径）
  useEffect(() => {
    if (!dirty) return;
    if (initialAutosaveSeconds <= 0) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void save();
    }, initialAutosaveSeconds * 1000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [dirty, save, initialAutosaveSeconds]);

  const publish = async () => {
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/featured/' + initial.issueNumber + '/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !body.ok) {
        throw { code: 'request_failed', message: body.error?.message ?? '发布失败。' } as ApiError;
      }
      setStatus('published');
      setNotice('已发布');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    const copy = [...items];
    const [row] = copy.splice(index, 1);
    copy.splice(next, 0, row);
    setItems(copy);
    markDirty();
  };

  const remove = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
    markDirty();
  };

  const patchItem = (index: number, patch: Partial<EditorItem>) => {
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
    markDirty();
  };

  const addItem = (pick: PickItem) => {
    if (items.some((item) => item.pluginId === pick.pluginId)) return;
    setItems([
      ...items,
      {
        pluginId: pick.pluginId,
        label: pick.label,
        repositoryFullName: pick.repositoryFullName,
        pluginPath: pick.pluginPath,
        avatarUrl: pick.avatarUrl,
        summary: '',
        reason: '',
        score: '',
        detailUrl: '',
        recommendedVersion: '',
      },
    ]);
    markDirty();
  };

  const openPicker = async (kind: 'favorites' | 'search') => {
    setPicker(kind);
    if (kind === 'favorites' && favorites === null) {
      try {
        const response = await fetch('/api/me/favorites', { cache: 'no-store' });
        const body = (await response.json()) as {
          data?: { plugins?: Array<{ plugin_id: string; display_name: string | null; plugin_path: string; full_name: string }> };
        };
        setFavorites(
          (body.data?.plugins ?? []).map((row) => ({
            pluginId: row.plugin_id,
            label: row.display_name ?? row.full_name,
            repositoryFullName: row.full_name,
            pluginPath: row.plugin_path,
            avatarUrl: null,
          })),
        );
      } catch {
        setFavorites([]);
      }
    }
  };

  const runSearch = async () => {
    const response = await fetch('/api/plugins/search?q=' + encodeURIComponent(searchQuery), {
      cache: 'no-store',
    });
    const body = (await response.json()) as {
      data?: { items?: Array<{ pluginId: string; displayName: string | null; pluginPath: string; repositoryFullName: string; ownerAvatarUrl: string | null }> };
    };
    setSearchResults(
      (body.data?.items ?? []).map((row) => ({
        pluginId: row.pluginId,
        label: row.displayName ?? row.repositoryFullName,
        repositoryFullName: row.repositoryFullName,
        pluginPath: row.pluginPath,
        avatarUrl: row.ownerAvatarUrl,
      })),
    );
  };

  const pickList = useMemo<PickItem[] | null>(
    () => (picker === 'favorites' ? favorites : picker === 'search' ? searchResults : null),
    [picker, favorites, searchResults],
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="panel">
        <div className="section-head">
          <h2>第 {initial.issueNumber} 期</h2>
          <span className={status === 'published' ? 'tag site' : 'tag warn'}>
            {status === 'published' ? '已发布' : '草稿'}
          </span>
        </div>

        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>标题</label>
        <input
          value={title}
          maxLength={80}
          onChange={(e) => {
            setTitle(e.target.value);
            markDirty();
          }}
          style={{ width: '100%', marginBottom: 10 }}
        />

        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>主题</label>
        <input
          value={theme}
          maxLength={200}
          onChange={(e) => {
            setTheme(e.target.value);
            markDirty();
          }}
          style={{ width: '100%', marginBottom: 10 }}
        />

        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>前言（Markdown）</label>
        <textarea
          value={preface}
          rows={6}
          onChange={(e) => {
            setPreface(e.target.value);
            markDirty();
          }}
          style={{ width: '100%' }}
        />
      </div>

      <div className="panel">
        <div className="section-head">
          <h2>插件清单（{items.length}）</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            顺序与文案绑定：上移/下移时这一项的全部内容一起移动
          </span>
        </div>

        {items.length === 0 ? (
          <p className="empty">还没有插件，从下面添加。</p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item, index) => (
              <li
                key={item.pluginId}
                style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 10 }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>
                    {index + 1}. {item.label}
                  </strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {item.repositoryFullName}
                    {item.pluginPath && item.pluginPath !== '.' ? ' / ' + item.pluginPath : ''}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                    <button type="button" className="button" disabled={index === 0} onClick={() => move(index, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={index === items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" className="button tonal" onClick={() => remove(index)}>
                      移除
                    </button>
                  </span>
                </div>

                <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>插件简述（1–200 字）</label>
                <input
                  value={item.summary}
                  maxLength={200}
                  onChange={(e) => patchItem(index, { summary: e.target.value })}
                  style={{ width: '100%' }}
                />

                <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>推荐理由（1–1000 字）</label>
                <textarea
                  value={item.reason}
                  rows={3}
                  onChange={(e) => patchItem(index, { reason: e.target.value })}
                  style={{ width: '100%' }}
                />

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                  <label style={{ fontSize: 13 }}>
                    评分（0–100，编辑按功能性打分）
                    <input
                      value={item.score}
                      inputMode="numeric"
                      onChange={(e) => patchItem(index, { score: e.target.value })}
                      style={{ width: 90, display: 'block' }}
                    />
                  </label>
                  <label style={{ fontSize: 13, flex: '1 1 320px' }}>
                    官方测试集链接（https，可空）
                    <input
                      value={item.detailUrl}
                      placeholder="https://"
                      onChange={(e) => patchItem(index, { detailUrl: e.target.value })}
                      style={{ width: '100%', display: 'block' }}
                    />
                  </label>
                  <label style={{ fontSize: 13 }}>
                    推荐版本（可选）
                    <input
                      value={item.recommendedVersion}
                      onChange={(e) => patchItem(index, { recommendedVersion: e.target.value })}
                      style={{ width: 140, display: 'block' }}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ol>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="button" onClick={() => void openPicker('favorites')}>
            从我的收藏夹导入
          </button>
          <button type="button" className="button" onClick={() => void openPicker('search')}>
            搜索插件目录添加
          </button>
        </div>

        {picker !== 'none' ? (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            {picker === 'search' ? (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <input
                  value={searchQuery}
                  placeholder="插件名 / 仓库名"
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ flex: '1 1 240px' }}
                />
                <button type="button" className="button" onClick={() => void runSearch()}>
                  搜索
                </button>
              </div>
            ) : null}

            {pickList === null ? (
              <p className="muted">读取中…</p>
            ) : pickList.length === 0 ? (
              <p className="muted">没有可添加的插件。</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 260, overflow: 'auto' }}>
                {pickList.map((pick) => {
                  const added = items.some((item) => item.pluginId === pick.pluginId);
                  return (
                    <li key={pick.pluginId} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                      <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                        {pick.label}
                        <span className="muted" style={{ fontSize: 12 }}> {pick.repositoryFullName}</span>
                      </span>
                      <button
                        type="button"
                        className="button"
                        disabled={added}
                        onClick={() => addItem(pick)}
                      >
                        {added ? '已添加' : '添加'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" className="button tonal" style={{ marginTop: 8 }} onClick={() => setPicker('none')}>
              收起
            </button>
          </div>
        ) : null}
      </div>

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="button primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存草稿'}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || status === 'published'}
          onClick={() => void publish()}
        >
          {status === 'published' ? '已发布' : '发布'}
        </button>
        <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
          {dirty ? '有未保存改动' : '已保存'}
          {' · 停手 ' + initialAutosaveSeconds + ' 秒自动保存'}
        </span>
      </div>
    </div>
  );
}
