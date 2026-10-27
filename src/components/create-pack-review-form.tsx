'use client';

/** 写整合包测评（针对某个版本，直接发布）。 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';
import { VERDICTS } from '@/packages/common/verdict';
import { ASSESSMENTS } from '@/packages/common/assessment';

export function CreatePackReviewForm({
  releaseId,
  packTitle,
  releaseNumber,
}: {
  releaseId: string;
  packTitle: string;
  releaseNumber: number;
}) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dshVersion, setDshVersion] = useState('');
  const [verdict, setVerdict] = useState('undetermined');
  const [assessmentLevel, setAssessmentLevel] = useState('quick');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/pack-releases/${encodeURIComponent(releaseId)}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          bodyMarkdown: body,
          dshVersion: JSON.stringify(
            dshVersion.trim() ? { kind: 'known', value: dshVersion.trim() } : { kind: 'unknown' },
          ),
          verdict,
          assessmentLevel,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { reviewId: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok || !payload.data) {
        throw { code: 'request_failed', message: payload.error?.message ?? '发表失败，请稍后重试。' } as ApiError;
      }
      router.push(`/reviews/${payload.data.reviewId}`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="panel" style={{ display: 'grid', gap: 10 }}>
      <p className="muted" style={{ margin: 0 }}>
        正在测评整合包：<strong>{packTitle}</strong>（第 {releaseNumber} 版）
      </p>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>标题（1-120 字）</span>
        <input type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>正文（Markdown）</span>
        <textarea value={body} rows={12} onChange={(e) => setBody(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>DSH 版本（可留空表示未知）</span>
        <input type="text" value={dshVersion} maxLength={80} onChange={(e) => setDshVersion(e.target.value)} />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>判定</span>
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          {VERDICTS.map((v) => (
            <option key={v.key} value={v.key}>{v.label}</option>
          ))}
        </select>
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>档位</span>
        <select value={assessmentLevel} onChange={(e) => setAssessmentLevel(e.target.value)}>
          {ASSESSMENTS.map((a) => (
            <option key={a.key} value={a.key}>{a.label}</option>
          ))}
        </select>
      </label>
      <div>
        <button type="submit" className="button primary" disabled={busy || title.trim() === '' || body.trim() === ''}>
          {busy ? '发表中…' : '发表测评'}
        </button>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </form>
  );
}
