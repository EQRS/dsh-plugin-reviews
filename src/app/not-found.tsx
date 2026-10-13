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

  const linkStyle = { color: '#2456B8' } as const;

  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #DBE1EA', borderRadius: 10, padding: 20, maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>找不到这个页面</h1>
      <p style={{ color: '#526174', margin: '0 0 12px' }}>
        地址可能写错了，或者它指向的内容已经被作者撤回 / 被隐藏。
        <strong>撤回或隐藏不是删除</strong>：原作者仍能在「我的」里看到自己的草稿与历史。
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
        <p style={{ color: '#526174', fontSize: 14, marginTop: 12, marginBottom: 0 }}>
          本次请求编号：<code style={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{requestId}</code>（服务端日志里是同一行）
        </p>
      ) : null}
    </div>
  );
}
