'use client';

/**
 * 根级错误边界：**根布局本身**出错时用它（连 `<html>`/`<body>` 都要自己写）。
 *
 * 它不该经常出现 —— 出现了说明连布局都没渲染成功，是最严重的一类页面故障，
 * 所以这里只保证一件事：**用户能拿到一个可以报给管理员的编号**，而不是一片空白。
 */

import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[全局异常]', error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          background: '#F3F5F8',
          color: '#1E293B',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          fontSize: 16,
          lineHeight: 1.7,
          padding: 24,
        }}
      >
        <div style={{ background: '#FFFFFF', border: '1px solid #DBE1EA', borderRadius: 10, padding: 20, maxWidth: 720 }}>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>站点暂时不可用</h1>
          <p style={{ color: '#526174', margin: '0 0 12px' }}>
            连页面框架都没能渲染出来，这通常意味着服务端有故障（比如数据库不可用）。请稍后再试；如果一直这样，把下面的编号报给管理员。
          </p>
          {error.digest ? (
            <p style={{ margin: '0 0 12px' }}>
              错误编号：
              <code
                style={{
                  display: 'inline-block',
                  marginLeft: 6,
                  background: '#F3F5F8',
                  border: '1px solid #DBE1EA',
                  borderRadius: 4,
                  padding: '1px 6px',
                  fontFamily: 'ui-monospace, Consolas, monospace',
                  fontSize: 14,
                }}
              >
                {error.digest}
              </code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              background: '#2456B8',
              color: '#FFFFFF',
              border: '1px solid #2456B8',
              borderRadius: 8,
              padding: '8px 16px',
              cursor: 'pointer',
              fontSize: 15,
            }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  );
}
