/**
 * 登录（最小切片：测试登录通道）。
 *
 * ⚠️ 边界说明（见 README-切片说明.md「未按文档实现」）：
 *  - 真实 GitHub OAuth 往返（state + S256 PKCE + 挑战表）**未实现**；
 *  - 本路由只在 `NODE_ENV !== 'production'` 下提供，用传入的 GitHub 身份桩直接建会话，
 *    用于本地演示与验收；生产环境直接拒绝，**不伪装成已接入 OAuth**。
 */

import { getDb } from '@/server/platform/db';
import { createIdentityService } from '@/server/modules/identity';
import { writeSessionCookie, clearSessionCookie, readSessionToken } from '@/server/platform/session-cookie';
import { err } from '@/packages/common/errors';
import { currentContext, okJson, errorResponse, requestMeta, readJson } from '../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    if (process.env.NODE_ENV === 'production') {
      throw err.notConfigured(
        'GitHub OAuth 尚未接入本站，生产环境不提供测试登录通道。',
      );
    }

    const body = (await readJson(request)) as {
      providerUserId?: unknown;
      providerUsername?: unknown;
      displayName?: unknown;
    };

    const providerUserId = typeof body.providerUserId === 'string' ? body.providerUserId : '';
    const providerUsername = typeof body.providerUsername === 'string' ? body.providerUsername : '';
    if (providerUserId.trim() === '' || providerUsername.trim() === '') {
      throw err.input('缺少 GitHub 身份标识。', [
        { path: 'providerUserId', message: '必填' },
        { path: 'providerUsername', message: '必填' },
      ]);
    }

    const identity = createIdentityService({ db: getDb() });
    const signIn = await identity.signInWithGithub(
      {
        providerUserId,
        providerUsername,
        profileUrl: `https://github.com/${providerUsername}`,
        avatarUrl: null,
        displayName: typeof body.displayName === 'string' ? body.displayName : providerUsername,
      },
      Date.now(),
    );
    const session = await identity.createSession(signIn.userId, Date.now());
    await writeSessionCookie(session.token);

    return okJson(
      {
        userId: signIn.userId,
        created: signIn.created,
        expiresAt: new Date(session.expiresAt).toISOString(),
        /** 明确标注这不是真实 OAuth 登录，避免被当成已接入。 */
        note: '测试登录通道：真实 GitHub OAuth 尚未接入。',
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 退出登录：撤销当前会话并清 Cookie。 */
export async function DELETE(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const token = await readSessionToken();
    if (token) {
      const identity = createIdentityService({ db: getDb() });
      const resolved = await identity.resolveSession(token, Date.now());
      if (resolved) await identity.revokeSession(resolved.sessionId, Date.now());
    }
    await clearSessionCookie();
    return okJson({ signedOut: true }, requestId);
  } catch (e) {
    return errorResponse(e, requestId);
  }
}

/** 当前登录者。 */
export async function GET(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);
  try {
    const ctx = await currentContext();
    return okJson(
      ctx.userId === null
        ? { authenticated: false as const }
        : { authenticated: true as const, userId: ctx.userId, role: ctx.role, accountStatus: ctx.accountStatus },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
