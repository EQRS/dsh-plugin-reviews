/**
 * 测试专用登录通道（**仅显式开启时可用**）。
 *
 * 为什么单独放在这里、而不是原来那条 /api/session：
 *  - `/api/session` 曾是"接受请求体身份"的登录 POST，那在生产里等于任何人都能
 *    声明自己是某个 GitHub 用户。现在那条路已经删除。
 *  - 自动化验收（HTTP 脚本）需要一个不必真点 GitHub 授权的入口。
 *
 * 闸门（必须同时满足，缺一不可）：
 *  1. 路由路径本身带 `testing/`，一眼能看出不是正式入口；
 *  2. 环境变量 `DSH_REVIEW_ALLOW_TEST_LOGIN` 正好等于 `1`；
 *  3. `NODE_ENV !== 'production'`（生产即使设了开关也不生效）。
 *
 * ⚠️ 两个踩过的坑，写下来免得重犯：
 *  - **不能**用目录名 `__test__`：Next.js 把 `_` 开头的目录视为私有目录、
 *    完全不参与路由，请求只会得到 Next 自己的 404 页面。
 *  - **不能**用 `NODE_ENV === 'test'` 判断：`next dev` 会强制把 NODE_ENV
 *    设为 development，本地跑验收时永远拿不到 test 值。
 */

import { getDb } from '@/server/platform/db';
import { createIdentityService } from '@/server/modules/identity';
import { writeSessionCookie } from '@/server/platform/session-cookie';
import { testLoginAllowed } from '@/server/platform/test-login';
import { err } from '@/packages/common/errors';
import { okJson, errorResponse, requestMeta, readJson } from '../../_lib/context';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const { requestId } = requestMeta(request);

  // 闸门：未显式开启一律 404，不泄露"这里有个登录通道"。
  if (!testLoginAllowed()) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const body = (await readJson(request)) as {
      providerUserId?: unknown;
      providerUsername?: unknown;
      displayName?: unknown;
    };

    const providerUserId = typeof body.providerUserId === 'string' ? body.providerUserId.trim() : '';
    const providerUsername = typeof body.providerUsername === 'string' ? body.providerUsername.trim() : '';
    if (providerUserId === '' || providerUsername === '') {
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
        note: '仅显式开启 DSH_REVIEW_ALLOW_TEST_LOGIN=1 且非生产环境时可用。',
      },
      requestId,
    );
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
