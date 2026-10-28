'use client';

/** 编辑未发布整合包版本（元数据；条目保持原样随请求带回）。 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice } from './api-client';
import type { ReleaseInput } from '@/server/modules/packs';

export function PackEditForm({ releaseId, initial }: { releaseId: string; initial: ReleaseInput }) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [purpose, setPurpose] = useState(initial.purpose);
  const [body, setBody] = useState(initial.bodyMarkdown);
  const [dshVersion, setDshVersion] = useState(
    initial.dshVersion.kind === 'known' ? initial.dshVersion.value : '',
  );
  const [configTemplate, setConfigTemplate] = useState(initial.configTemplate ?? '');
  const [testStatus, setTestStatus] = useState<'untested' | 'tested'>(initial.testStatus);
  const [testTask, setTestTask] = useState(initial.testTask ?? '');
  const [testResult, setTestResult] = useState(initial.testResult ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body2: ReleaseInput = {
        ...initial,
        title,
        purpose,
        bodyMarkdown: body,
        dshVersion: dshVersion.trim() ? { kind: 'known', value: dshVersion.trim() } : { kind: 'unknown' },
        configTemplate: configTemplate.trim() === '' ? null : configTemplate,
        testStatus,
        testTask: testStatus === 'tested' ? testTask : null,
        testResult: testStatus === 'tested' ? testResult : null,
      };
      const response = await fetch(`/api/pack-releases/${encodeURIComponent(releaseId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body2),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '保存失败。' } as ApiError;
      }
      router.push('/me/packs');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="panel" style={{ display: 'grid', gap: 10 }}>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>名称（1-80 字）</span>
        <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>用途说明（1-2000 字）</span>
        <textarea value={purpose} maxLength={2000} rows={3} onChange={(e) => setPurpose(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>组合使用说明（Markdown）</span>
        <textarea value={body} rows={10} onChange={(e) => setBody(e.target.value)} required />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>DSH 版本（留空 = 未知）</span>
        <input value={dshVersion} maxLength={100} onChange={(e) => setDshVersion(e.target.value)} />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>配置模板（可选）</span>
        <textarea value={configTemplate} rows={5} onChange={(e) => setConfigTemplate(e.target.value)} />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>实测状态</span>
        <select value={testStatus} onChange={(e) => setTestStatus(e.target.value as 'untested' | 'tested')}>
          <option value="untested">未实测</option>
          <option value="tested">作者已实测</option>
        </select>
      </label>
      {testStatus === 'tested' ? (
        <>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>测试任务</span>
            <input value={testTask} onChange={(e) => setTestTask(e.target.value)} required />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>测试结果</span>
            <textarea value={testResult} rows={3} onChange={(e) => setTestResult(e.target.value)} required />
          </label>
        </>
      ) : null}
      <div>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? '保存中…' : '保存草稿'}
        </button>
      </div>
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </form>
  );
}
