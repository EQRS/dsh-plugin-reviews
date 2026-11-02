'use client';

/**
 * 问题反馈表单（客户侧）。
 *
 * 两件克制的事：
 *   1. **类型先选**：选中后才显示对应字段提示，避免一上来就是十几个框；
 *   2. **上下文只按白名单取**：UA / 屏幕 / 语言 / 时区 / 平台，绝不整体序列化 navigator，
 *      也不采集 IP、Cookie、localStorage（设计 §6.2 的边界）。
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, ErrorNotice, SuccessNotice } from './api-client';
import { FEEDBACK_KINDS, FEEDBACK_KIND_LABELS } from '@/packages/common/feedback';
import type { FeedbackKind } from '@/packages/common/feedback';

/** 各类型的提示语与字段说明——写在这里，页面只负责渲染。 */
const KIND_HINTS: Record<FeedbackKind, { bodyHint: string; bodyPlaceholder: string }> = {
  bug: {
    bodyHint: '说清楚：你在哪一页、点了什么、看到什么、期望什么。有截图更好。',
    bodyPlaceholder: '例如：在插件目录搜索「记忆」后点回车，页面没有跳转；手动点放大镜可以。Chrome 120 / Windows。',
  },
  feature: {
    bodyHint: '你希望加什么能力？它解决你现在的什么困难？',
    bodyPlaceholder: '例如：希望能按「是否支持 Windows」筛选插件，现在只能一个个点进去看。',
  },
  content: {
    bodyHint: '如果是某个插件资料写错，也可以用插件页的「纠错」；这里适合评测内容或文字表达问题。',
    bodyPlaceholder: '例如：这篇评测里贴的命令少了一个参数，照抄会报错。',
  },
  account: {
    bodyHint: '登录、头像、昵称、权限相关的问题放这里。别写密码或 token。',
    bodyPlaceholder: '例如：GitHub 登录后昵称还是旧的，个人设置里改了没生效。',
  },
  other: { bodyHint: '没想好归类就放这里，我们会自己分流。', bodyPlaceholder: '' },
};

/** 只取白名单字段；取不到就跳过，不写空字符串。 */
function collectContext(): string | null {
  try {
    const ctx: Record<string, string | number> = {
      ua: navigator.userAgent.slice(0, 300),
      lang: navigator.language,
      screen: window.screen.width + 'x' + window.screen.height,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
    if (typeof platform === 'string' && platform.length > 0) ctx.ua_platform = platform.slice(0, 40);
    const json = JSON.stringify(ctx);
    return json.length > 2000 ? null : json;
  } catch {
    return null;
  }
}

export function FeedbackForm({ defaultPageUrl = '' }: { defaultPageUrl?: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pageUrl, setPageUrl] = useState(defaultPageUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hint = useMemo(() => KIND_HINTS[kind], [kind]);
  const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          title,
          body,
          pageUrl: pageUrl.trim() === '' ? null : pageUrl.trim(),
          contextJson: collectContext(),
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { ticketId?: string; created?: boolean };
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok) {
        throw { code: 'request_failed', message: payload.error?.message ?? '提交失败。' } as ApiError;
      }
      setNotice(payload.data?.created === false ? '同类问题今天已经提交过，已为你关联到原反馈。' : '已收到，处理结果会通过站内通知发给你。');
      setTitle('');
      setBody('');
      router.refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <p style={{ margin: '0 0 6px', fontSize: 13 }}>类型</p>
        <div className="filters" style={{ marginBottom: 0 }}>
          {FEEDBACK_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={kind === k ? 'button primary' : 'button'}
              onClick={() => setKind(k)}
            >
              {FEEDBACK_KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      <label style={{ fontSize: 13 }}>
        标题
        <input
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="一句话说清问题"
          style={{ width: '100%', display: 'block' }}
        />
      </label>

      <label style={{ fontSize: 13 }}>
        详细描述
        <textarea
          value={body}
          rows={6}
          maxLength={5000}
          onChange={(e) => setBody(e.target.value)}
          placeholder={hint.bodyPlaceholder}
          style={{ width: '100%', display: 'block' }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {hint.bodyHint}
        </span>
      </label>

      <label style={{ fontSize: 13 }}>
        出问题的页面（站内路径，可留空）
        <input
          value={pageUrl}
          maxLength={1000}
          onChange={(e) => setPageUrl(e.target.value)}
          placeholder="/plugins?q=..."
          style={{ width: '100%', display: 'block' }}
        />
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="button primary" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? '提交中…' : '提交反馈'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          会自动带上浏览器与屏幕信息，便于定位；不会带 IP、Cookie 或你输入过的其它内容。
        </span>
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}
