'use client';

/**
 * 页面级错误边界（App Router 约定文件）。
 *
 * 以前没有它的后果：页面里任何未捕获异常都会落到 Next 的默认错误页 ——
 * 英文、白屏、且**不给用户任何可报的编号**，服务端日志与用户看到的东西对不上。
 *
 * 这里做三件事：中文说明、把 `digest` 显示出来（服务端日志里记的是同一个值）、
 * 给"重试"与"回首页"两个出口。
 */

import { useEffect } from 'react';
import Link from 'next/link';

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // 浏览器控制台留一份：用户截图给我们时能直接看到
    console.error('[页面异常]', error);
  }, [error]);

  return (
    <div
      style={{
        background: '#FFFFFF',
        border: '1px solid #DBE1EA',
        borderRadius: 10,
        padding: 20,
        maxWidth: 720,
      }}
    >
      <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>这个页面出错了</h1>
      <p style={{ color: '#526174', margin: '0 0 12px' }}>
        服务端在处理这个页面时遇到了没有预期的错误。
        <strong>你的数据没有因此丢失</strong>：出错前已保存的草稿与已提交的内容都还在。
      </p>

      {error.digest ? (
        <p style={{ margin: '0 0 12px' }}>
          把这个编号告诉管理员，就能在服务端日志里定位到这一次请求：
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
      ) : (
        <p style={{ color: '#526174', margin: '0 0 12px' }}>
          这次错误没有编号（通常发生在开发环境）。下面的按钮一般就能恢复。
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
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
        <Link
          href="/"
          style={{
            border: '1px solid #DBE1EA',
            borderRadius: 8,
            padding: '8px 16px',
            color: '#2456B8',
            textDecoration: 'none',
          }}
        >
          回首页
        </Link>
      </div>
    </div>
  );
}
