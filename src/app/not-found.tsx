/**
 * 404 页面（App Router 约定文件）。
 *
 * 以前没有它的后果：不存在的地址落到 Next 的默认 404 —— 英文、且没有任何回站内的路。
 * 这里给中文说明 + 三个真实入口，并显示 `request_id`（服务端访问日志里有同一行），
 * 这样"用户说某个链接 404 了"能被精确定位到那一次请求。
 */

import Link from 'next/link';
import { headers } from 'next/headers';

export default async function NotFound() {
  const headerList = await headers();
  const requestId = headerList.get('x-request-id');

  const linkStyle = { color: 'var(--accent)' } as const;

  return (
    <div className="panel" style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>找不到这个页面</h1>
      <p className="muted" style={{ marginBottom: 12 }}>
        地址可能写错了，或者它指向的内容已被作者撤回或被隐藏。
      </p>
      <p style={{ margin: 0 }}>
        可以回到：
        <Link href="/plugins" style={{ ...linkStyle, marginLeft: 6 }}>
          插件目录
        </Link>
        {' · '}
        <Link href="/reviews" style={linkStyle}>
          全部评测
        </Link>
        {' · '}
        <Link href="/" style={linkStyle}>
          首页
        </Link>
      </p>
      {requestId ? (
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          本次请求编号：<code style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{requestId}</code>
        </p>
      ) : null}
    </div>
  );
}