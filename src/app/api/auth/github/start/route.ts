/**
 * 发起 GitHub 登录（架构第 11 节）。
 *
 * GET /api/auth/github/start?returnTo=/plugins
 *
 * 流程：建一次性挑战（state + 浏览器绑定 + PKCE verifier）→ 写绑定 cookie → 302 到 GitHub。
 * 未配置 GitHub 凭据时返回 `provider_not_configured`，**不伪装成可用**。
 */

import { cookies } from 'next/headers';
import { getDb } from '@/server/platform/db';
import { createGithubLoginAdapter } from '@/server/adapters/login';
import {
  createOAuthChallengeService,
  BROWSER_BINDING_COOKIE,
  normalizeReturnPath,
} from '@/server/modules/identity/oauth-challenges';
import { cookieSecure } from '@/server/platform/session-cookie';
import { errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const url = new URL(request.url);
    const returnTo = normalizeReturnPath(url.searchParams.get('returnTo'));

    const adapter = createGithubLoginAdapter();
    const challenges = createOAuthChallengeService(getDb());
    const created = challenges.create({ returnPath: returnTo });

    // 绑定 cookie：只用于"这次回调是否来自同一个浏览器"，**不代表已登录**。
    // Secure 标志与会话 Cookie 用同一个判断（`cookieSecure()`）—— 分开写就会在
    // "生产但没有 TLS"的部署里漏掉一处，表现为回调时绑定校验失败。
    const store = await cookies();
    store.set(BROWSER_BINDING_COOKIE, created.browserBinding, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      path: '/',
      // 与挑战有效期同寿命，避免长期留存临时绑定
      maxAge: 600,
    });

    const authorizeUrl = adapter.buildAuthorizeUrl(created.state, created.codeChallenge);
    return new Response(null, {
      status: 302,
      headers: { location: authorizeUrl, 'x-request-id': requestId },
    });
  } catch (e) {
    // 未配置凭据时给出可读页面，而不是把用户扔到一个 JSON 错误里
    const errRes = errorResponse(e, requestId);
    if (errRes.status === 503) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>GitHub 登录未配置</title>
         <body style="margin:0;background:#111318;color:#ffffff;font-family:system-ui;line-height:1.7">
         <div style="max-width:640px;margin:80px auto;padding:0 24px">
           <h1 style="font-size:20px">GitHub 登录尚未配置</h1>
           <p>本站还没配置 GitHub OAuth 凭据，因此暂时无法用 GitHub 账号登录。</p>
           <p>需要在部署配置里提供 <code>GITHUB_CLIENT_ID</code>、<code>GITHUB_CLIENT_SECRET</code>
              与 <code>GITHUB_REDIRECT_URI</code>（回调地址填
              <code>http://127.0.0.1:3100/api/auth/github/callback</code>）。</p>
           <p style="color:#8c9199;font-size:14px">追踪号：${requestId}</p>
           <p><a href="/" style="color:#8ab4f8">返回首页</a></p>
         </div></body>`,
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'x-request-id': requestId } },
      );
    }
    return errRes;
  }
}
