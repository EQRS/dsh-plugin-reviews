/**
 * GitHub 登录回调（架构第 11 节、依赖与部署第 5 节）。
 *
 * GET /api/auth/github/callback?code=...&state=...
 *
 * 顺序（每一步都必须真实通过，任一步失败即不建立会话）：
 *   1. 读浏览器绑定 cookie → 与挑战里的**摘要**比对；
 *   2. 用 state 找到挑战，核验未过期、未消费，并**原子消费**；
 *   3. 用 code + verifier 换 GitHub 稳定身份（未配置/网络故障 → 明确错误，不伪造身份）；
 *   4. 建立或复用站内用户 → 建会话 → 写 Cookie → 302 回站内路径。
 */

import { cookies } from 'next/headers';
import { getDb } from '@/server/platform/db';
import { createGithubLoginAdapter } from '@/server/adapters/login';
import {
  createOAuthChallengeService,
  BROWSER_BINDING_COOKIE,
} from '@/server/modules/identity/oauth-challenges';
import { createIdentityService } from '@/server/modules/identity';
import { writeSessionCookie } from '@/server/platform/session-cookie';
import { errorResponse, requestMeta } from '../../../_lib/context';

export const runtime = 'nodejs';

function htmlError(message: string, requestId: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>登录未完成</title>
     <body style="margin:0;background:#111318;color:#ffffff;font-family:system-ui;line-height:1.7">
     <div style="max-width:640px;margin:80px auto;padding:0 24px">
       <h1 style="font-size:20px">登录未完成</h1>
       <p>${message}</p>
       <p style="color:#8c9199;font-size:14px">追踪号：${requestId}</p>
       <p><a href="/" style="color:#8ab4f8">返回首页</a> · <a href="/api/auth/github/start" style="color:#8ab4f8">重新登录</a></p>
     </div></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-request-id': requestId } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    // GitHub 在用户拒绝授权时会带回 error
    const ghError = url.searchParams.get('error');
    if (ghError) {
      return htmlError('你取消了 GitHub 授权，未建立登录。', requestId, 400);
    }
    if (!code || !state) {
      return htmlError('回调缺少必要参数（code / state）。', requestId, 400);
    }

    const store = await cookies();
    const browserBinding = store.get(BROWSER_BINDING_COOKIE)?.value ?? null;
    if (!browserBinding) {
      return htmlError('找不到本次登录的浏览器绑定，请从站内重新发起登录。', requestId, 400);
    }

    // 1+2) 核验并消费挑战（state 摘要、浏览器绑定摘要、未过期、未消费）
    const challenges = createOAuthChallengeService(getDb());
    const consumed = challenges.consume({ state, browserBinding });

    // 3) 换身份（真实网络调用；失败不建立登录）
    const adapter = createGithubLoginAdapter();
    const identity = await adapter.exchangeCodeForIdentity({
      code,
      codeVerifier: consumed.codeVerifier,
    });

    // 4) 建站内用户与会话
    const identityService = createIdentityService({ db: getDb() });
    const signIn = await identityService.signInWithGithub(identity, Date.now());
    const session = await identityService.createSession(signIn.userId, Date.now());
    await writeSessionCookie(session.token);

    // 清掉临时绑定 cookie（它已完成使命）
    store.set(BROWSER_BINDING_COOKIE, '', { path: '/', maxAge: 0 });

    // 明确区分"新用户"与"老用户"：新用户引导到资料确认页
    const target = signIn.created ? `/onboarding?returnTo=${encodeURIComponent(consumed.returnPath)}` : consumed.returnPath;

    return new Response(null, { status: 302, headers: { location: target, 'x-request-id': requestId } });
  } catch (e) {
    const res = errorResponse(e, requestId);
    // 业务性失败（挑战无效/过期/已用）给可读页面；未配置/故障也如实说明
    let body: { error?: { message?: string } } = {};
    try {
      body = JSON.parse(await res.clone().text()) as typeof body;
    } catch {
      /* 忽略 */
    }
    const message = body.error?.message ?? '登录过程中出现异常，请重试。';
    return htmlError(message, requestId, res.status >= 400 && res.status < 600 ? res.status : 400);
  }
}
