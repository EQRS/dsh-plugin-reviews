/**
 * 提交插件页。
 *
 * 服务端只做"是否登录"的引导；提交与错误呈现交给客户端表单，
 * 因为它需要在原地显示后端返回的 message。
 *
 * 版式：只有一块表单的页面用 `.form-page` 收窄，返回入口统一用 `.back-link`。
 */

import { currentContext } from '@/app/api/_lib/context';
import { BackLink } from '@/components/back-link';
import { PluginSubmitForm } from '@/components/plugin-submit-form';

export const dynamic = 'force-dynamic';

export default async function NewPluginPage() {
  const ctx = await currentContext();

  return (
    <div className="form-page">
      <BackLink href="/plugins">返回插件目录</BackLink>

      <h1>提交插件</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        提交一个 GitHub 仓库链接，检查通过后才会建立插件条目。收录不等于已实测可用。
      </p>

      {ctx.userId === null ? (
        <div className="notice warn">
          提交插件需要登录。请使用页面顶部的登录入口。
        </div>
      ) : null}

      <div className="panel" style={{ marginTop: 16 }}>
        <PluginSubmitForm />
      </div>
    </div>
  );
}