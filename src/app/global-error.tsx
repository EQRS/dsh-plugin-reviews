'use client';

/**
 * 根级错误边界：**根布局本身**出错时用它（连 `<html>`/`<body>` 都要自己写）。
 *
 * 它不该经常出现 —— 出现了说明连布局都没渲染成功，是最严重的一类页面故障，
 * 所以这里只保证一件事：**用户能拿到一个可以报给管理员的编号**，而不是一片空白。
 *
 * ⚠️ 样式为什么是**内联字面量**而不是 globals.css 的 token：
 * 这个组件是在根布局**之外**渲染的，`layout.tsx` 里那句 `import './globals.css'`
 * 不会跟着加载，`var(--bg)` / `.panel` 全部取不到值，页面会退回浏览器默认的**浅色**。
 * 所以本文件刻意自包含（与两个 OAuth 错误页同样的理由）；改主题时这里要手工同步：
 * 底 #111318 / 面板 #1a1d23 / 描边 rgba(255,255,255,.08) / 正文 #fff / 次要 #c2c7cf /
 * 强调 #8ab4f8 / 强调底上的字 #002e69。
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
          background: '#111318',
          color: '#ffffff',
          fontFamily:
            "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
          fontSize: 16,
          lineHeight: 1.7,
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 720,
            padding: 24,
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 14,
            background: '#1a1d23',
          }}
        >
          <h1
            style={{
              marginTop: 0,
              marginBottom: 8,
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
            }}
          >
            站点暂时不可用
          </h1>
          <p style={{ marginTop: 0, marginBottom: 12, color: '#c2c7cf', fontSize: 14 }}>
            连页面框架都没能渲染出来，这通常意味着服务端有故障（比如数据库不可用）。请稍后再试；如果一直这样，把下面的编号报给管理员。
          </p>
          {error.digest ? (
            <p style={{ marginBottom: 12 }}>
              错误编号：
              <code
                style={{
                  display: 'inline-block',
                  marginLeft: 6,
                  padding: '1px 6px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 4,
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: '#8ab4f8',
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
              minHeight: 44,
              padding: '10px 18px',
              border: 0,
              borderRadius: 999,
              background: '#8ab4f8',
              color: '#002e69',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  );
}