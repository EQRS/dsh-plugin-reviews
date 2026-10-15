/**
 * 收录插件页（任务 7 第 2 项）。
 *
 * 服务端只做"是否登录"的最小引导；真正的提交与错误呈现交给客户端表单，
 * 因为它需要在原地显示后端返回的 message（不整页跳走）。
 */

import Link from 'next/link';
import { currentContext } from '@/app/api/_lib/context';
import { PluginSubmitForm } from '@/components/plugin-submit-form';

export const dynamic = 'force-dynamic';

export default async function NewPluginPage() {
  const ctx = await currentContext();

  return (
    <div style={{ maxWidth: 720 }}>
      <h1>收录插件</h1>
      <p className="muted">
        提交一个 GitHub 仓库链接，本站会做收录检查后建立插件条目。收录不等于已实测可用。
      </p>

      {ctx.userId === null ? (
        <div className="notice warn">
          收录需要登录。请使用页面顶部的登录入口。
          {ctx.userId === null ? (
            <>
              {' '}
              当前未登录，<Link href="/">返回首页</Link>。
            </>
          ) : null}
        </div>
      ) : null}

      <div className="panel" style={{ marginTop: 16 }}>
        <PluginSubmitForm />
      </div>

      <p style={{ marginTop: 16 }}>
        <Link href="/plugins" className="muted">
          ← 返回插件目录
        </Link>
      </p>
    </div>
  );
}