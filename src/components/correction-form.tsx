'use client';

/**
 * 「反馈资料错误」表单（`idea.md §2`）。
 *
 * 只允许改两项：展示名与简介 —— 与后端白名单一致（分类是仓库级的，不在其中）。
 * 留空 = 该项不提修改建议；至少填一项，否则后端会拒绝。
 */

import { useState } from 'react';
import { ApiError, ErrorNotice, apiFetch, buttonStyle, inputStyle } from './api-client';

export function CorrectionForm({
  pluginId,
  currentName,
  currentDescription,
  authenticated,
}: {
  pluginId: string;
  currentName: string | null;
  currentDescription: string | null;
  authenticated: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const proposed: Record<string, string> = {};
      if (name.trim().length > 0) proposed.display_name = name.trim();
      if (description.trim().length > 0) proposed.description = description.trim();
      const result = await apiFetch<{ correctionId: string; created: boolean }>(
        `/api/plugins/${encodeURIComponent(pluginId)}/corrections`,
        {
          method: 'POST',
          json: { proposed, description: note, referenceUrl: referenceUrl.trim() || undefined },
        },
      );
      setDone(result.created ? '已提交，管理员核对后会在通知里告诉你结果。' : '你之前已经提交过同样的纠错，还在处理中。');
      setOpen(false);
      setName('');
      setDescription('');
      setNote('');
      setReferenceUrl('');
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <button
        type="button"
        onClick={() => (authenticated ? setOpen((v) => !v) : setOpen(false))}
        disabled={!authenticated}
        title={authenticated ? '资料有误？告诉我们' : '登录后才能反馈'}
        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: authenticated ? 'pointer' : 'not-allowed', padding: 0, fontSize: 13 }}
      >
        反馈资料错误
      </button>
      {done ? <span style={{ color: 'var(--success-ink)' }}>{done}</span> : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {open ? (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(16,24,40,0.35)', display: 'grid', placeItems: 'center', zIndex: 50 }}
          role="dialog"
          aria-label="反馈资料错误"
        >
          <div
            style={{
              background: 'var(--md-sys-color-surface-container-high)',
              color: 'var(--md-sys-color-on-surface)',
              borderRadius: 12,
              padding: 18,
              width: 'min(560px, 92vw)',
            }}
          >
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>反馈资料错误</h3>
            <p style={{ margin: '0 0 12px', color: 'var(--md-sys-color-on-surface-variant)', fontSize: 13 }}>
              只需要填写要改的部分；留空表示该项没问题。管理员核对后会采纳或驳回。
            </p>

            <label style={{ display: 'block', fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>
              展示名（现在是：{currentName ?? '（空）'}）
            </label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="建议改成…" style={{ ...inputStyle, width: '100%', marginBottom: 10 }} />

            <label style={{ display: 'block', fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>
              简介（现在是：{currentDescription ?? '（空）'})
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="建议改成…"
              style={{ ...inputStyle, width: '100%', marginBottom: 10 }}
            />

            <label style={{ display: 'block', fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>说明（必填）</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="例如：GitHub README 已经改名了"
              style={{ ...inputStyle, width: '100%', marginBottom: 10 }}
            />

            <label style={{ display: 'block', fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)', marginBottom: 4 }}>参考链接（可选）</label>
            <input
              value={referenceUrl}
              onChange={(e) => setReferenceUrl(e.target.value)}
              placeholder="https://github.com/…"
              style={{ ...inputStyle, width: '100%' }}
            />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  ...buttonStyle,
                  background: 'var(--md-sys-color-surface-container-highest)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || note.trim().length === 0 || (name.trim() === '' && description.trim() === '')}
                onClick={() => void submit()}
                style={buttonStyle}
              >
                {busy ? '提交中…' : '提交'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </span>
  );
}
